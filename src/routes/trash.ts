import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const trashRouter = Router();
trashRouter.use(requireAuth);

const RestoreSchema = z.object({
    resourceType: z.enum(['file', 'folder']),
    resourceId: z.string().uuid(),
});

// GET /api/trash - all deleted items for the authenticated user
trashRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;

        const files = await query(
            `SELECT id, name, mime_type, size_bytes, updated_at as deleted_at
             FROM files
             WHERE owner_id = $1 AND is_deleted = true
             ORDER BY deleted_at DESC`,
            [userId]
        );

        const folders = await query(
            `SELECT id, name, updated_at as deleted_at
             FROM folders
             WHERE owner_id = $1 AND is_deleted = true
             ORDER BY deleted_at DESC`,
            [userId]
        );

        res.json({ files, folders });
    } catch (err) {
        next(err);
    }
});

// POST /api/trash/restore - restore a deleted file or folder
trashRouter.post("/restore", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = RestoreSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('VALIDATION_ERROR', body.error.issues[0].message, 400);
    }

    const { resourceType, resourceId } = body.data;
    const { userId } = req.user!;

    if (resourceType === 'file') {
        const rows = await query(
            `UPDATE files SET is_deleted = false, updated_at = now()
            WHERE id = $1 AND owner_id = $2 AND is_deleted = true
            RETURNING id, name`,
            [resourceId, userId]
        );
        if (rows.length === 0) {
            throw new AppError('NOT_FOUND', 'File not found or not deleted', 404);
        }
        return res.json({ message: `"${rows[0].name}" restored successfully`, file: rows[0] });
    }

    // Restoring a folder + all descendants 
    await query (
        `WITH RECURSIVE descendants AS (
            SELECT id FROM folders WHERE id = $1
            UNION ALL
            SELECT f.id FROM folders f
            JOIN descendants d ON f.parent_id = d.id
        )
        UPDATE folders SET is_deleted = false, updated_at = now()
        WHERE id IN (SELECT id FROM descendants)`,
        [resourceId]
    );

    // Restore files inside the folder tree
    await query (
        `WITH RECURSIVE descendants AS (
            SELECT id FROM folders WHERE id = $1
            UNION ALL
            SELECT f.id FROM folders f
            JOIN descendants d ON f.parent_id = d.id
        )
        UPDATE files SET is_deleted = false, updated_at = now()
        WHERE folder_id IN (SELECT id FROM descendants)`,
        [resourceId]
    );

    res.json({ message: 'Folder and its contents restored successfully' });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/trash/purge - permanently delete a file or folder
trashRouter.delete('/purge/:resourceType/:resourceId', 
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { userId } = req.user!;
            const { resourceType, resourceId } = req.params;

            if (resourceType === 'file') {
                await query(
                    `DELETE FROM files
                    WHERE id = $1 AND owner_id = $2 AND is_deleted = true`,
                    [resourceId, userId]
                );
            } else {
                // First delete files inside the folder tree
                await query(
                    `WITH RECURSIVE descendants AS (
                        SELECT id FROM folders WHERE id = $1
                        UNION ALL
                        SELECT f.id FROM folders f
                        JOIN descendants d ON f.parent_id = d.id
                    )
                    DELETE FROM files
                    WHERE folder_id IN (SELECT id FROM descendants)`,
                    [resourceId]
                );
                // Then delete the folder and its subfolders
                await query(
                    `WITH RECURSIVE descendants AS (
                        SELECT id FROM folders WHERE id = $1
                        UNION ALL
                        SELECT f.id FROM folders f
                        JOIN descendants d ON f.parent_id = d.id
                    )
                    DELETE FROM folders
                    WHERE id IN (SELECT id FROM descendants) AND owner_id = $2`,
                    [resourceId, userId]
                );
            }

            res.json({ message: 'Resource permanently deleted' });
        } catch (err) {
            next(err);
        }
    }
);
