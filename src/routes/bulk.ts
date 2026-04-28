/**
 * bulk.ts — Bulk Operations Routes
 *
 * ─── LEARNING NOTES ────────────────────────────────────────
 *
 * WHY bulk operations?
 * If a user wants to delete 50 files, making 50 individual HTTP DELETE
 * requests is inefficient. It wastes connection overhead, increases server
 * load, and can trigger rate limits.
 * A single bulk request groups these into one transaction.
 *
 * SQL `ANY()` operator:
 * Instead of `WHERE id IN (1, 2, 3)`, which requires building a dynamic query
 * string, we can use PostgreSQL's `ANY($1::uuid[])` where $1 is an array.
 * This is cleaner and more secure against SQL injection.
 *
 * TRANSACTIONS (`BEGIN` / `COMMIT` / `ROLLBACK`):
 * When moving or deleting multiple items, we want an "all-or-nothing" approach.
 * If 49 items succeed but the 50th fails, we don't want partial state.
 * Wrapping the queries in a transaction ensures atomic execution.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getClient } from "../db/client"; // Need raw client for transactions
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { getFolderAccess, canWriteFolderAccess } from "../services/acl";

export const bulkRouter = Router();
bulkRouter.use(requireAuth);

const BulkOpSchema = z.object({
    fileIds: z.array(z.string().uuid()).default([]),
    folderIds: z.array(z.string().uuid()).default([]),
});

const BulkMoveSchema = BulkOpSchema.extend({
    targetFolderId: z.string().uuid().nullable(),
});

// ── POST /api/bulk/delete ────────────────────────────────────
// Soft delete multiple files and folders in a single transaction.
bulkRouter.post("/delete", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = BulkOpSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError("VALIDATION_ERROR", body.error.issues[0].message, 400);
        }
        
        const { fileIds, folderIds } = body.data;
        const { userId } = req.user!;

        if (fileIds.length === 0 && folderIds.length === 0) {
            res.json({ message: "No items provided" });
            return;
        }

        const client = await getClient();
        try {
            await client.query("BEGIN"); // Start transaction

            // 1. Delete Files (owned by user)
            if (fileIds.length > 0) {
                await client.query(
                    `UPDATE files 
                     SET is_deleted = true, updated_at = now() 
                     WHERE id = ANY($1::uuid[]) AND owner_id = $2`,
                    [fileIds, userId]
                );
            }

            // 2. Delete Folders (owned by user) and their descendants
            if (folderIds.length > 0) {
                // First soft delete the target folders and all their subfolders
                await client.query(
                    `WITH RECURSIVE to_delete AS (
                        SELECT id FROM folders WHERE id = ANY($1::uuid[]) AND owner_id = $2
                        UNION ALL
                        SELECT f.id FROM folders f
                        JOIN to_delete d ON f.parent_id = d.id
                    )
                    UPDATE folders
                    SET is_deleted = true, updated_at = now()
                    WHERE id IN (SELECT id FROM to_delete)`,
                    [folderIds, userId]
                );

                // Then soft delete all files within that folder hierarchy
                await client.query(
                    `WITH RECURSIVE descendants AS (
                        SELECT id FROM folders WHERE id = ANY($1::uuid[]) AND owner_id = $2
                        UNION ALL
                        SELECT f.id FROM folders f
                        JOIN descendants d ON f.parent_id = d.id
                    )
                    UPDATE files SET is_deleted = true, updated_at = now()
                    WHERE folder_id IN (SELECT id FROM descendants)`,
                    [folderIds, userId]
                );
            }

            await client.query("COMMIT"); // Commit transaction
            res.json({ message: "Items deleted successfully" });
        } catch (err) {
            await client.query("ROLLBACK"); // Roll back if anything fails
            throw err;
        } finally {
            client.release(); // Return client to pool
        }
    } catch (err) {
        next(err);
    }
});

// ── POST /api/bulk/move ──────────────────────────────────────
// Move multiple files and folders into a target folder.
bulkRouter.post("/move", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = BulkMoveSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError("VALIDATION_ERROR", body.error.issues[0].message, 400);
        }
        
        const { fileIds, folderIds, targetFolderId } = body.data;
        const { userId } = req.user!;

        if (fileIds.length === 0 && folderIds.length === 0) {
            res.json({ message: "No items provided" });
            return;
        }

        // Validate target folder if it's not root
        if (targetFolderId) {
            const fa = await getFolderAccess(userId, targetFolderId);
            if (!fa || !canWriteFolderAccess(fa.access)) {
                throw new AppError("NOT_FOUND", "Target folder not found or forbidden", 404);
            }
            
            // Basic cycle detection: cannot move a folder into itself
            // (A deeper recursive cycle detection check would be ideal for production)
            if (folderIds.includes(targetFolderId)) {
                throw new AppError("CONFLICT", "Cannot move a folder into itself", 409);
            }
        }

        const client = await getClient();
        try {
            await client.query("BEGIN");

            if (fileIds.length > 0) {
                await client.query(
                    `UPDATE files 
                     SET folder_id = $1::uuid, updated_at = now() 
                     WHERE id = ANY($2::uuid[]) AND owner_id = $3`,
                    [targetFolderId, fileIds, userId]
                );
            }

            if (folderIds.length > 0) {
                await client.query(
                    `UPDATE folders 
                     SET parent_id = $1::uuid, updated_at = now() 
                     WHERE id = ANY($2::uuid[]) AND owner_id = $3`,
                    [targetFolderId, folderIds, userId]
                );
            }

            await client.query("COMMIT");
            res.json({ message: "Items moved successfully" });
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        next(err);
    }
});
