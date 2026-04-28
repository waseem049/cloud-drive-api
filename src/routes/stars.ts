import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { getFileAccess, getFolderAccess } from "../services/acl";

export const starsRouter = Router();
starsRouter.use(requireAuth);

const StarBodySchema = z.object({
    resourceType: z.enum(["file", "folder"]),
    resourceId: z.string().uuid(),
});

// GET /api/stars — list starred files and folders
starsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;

        const files = await query(
            `SELECT f.id, f.name, f.mime_type, f.size_bytes, f.folder_id, f.created_at, f.updated_at
             FROM stars s
             JOIN files f ON f.id = s.resource_id AND s.resource_type = 'file'
             WHERE s.user_id = $1
               AND f.is_deleted = false AND f.status = 'ready'
               AND (
                   f.owner_id = $1::uuid
                   OR EXISTS (SELECT 1 FROM shares sh WHERE sh.resource_type = 'file' AND sh.resource_id = f.id AND sh.grantee_id = $1::uuid)
                   OR (f.folder_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM shares sh
                       WHERE sh.resource_type = 'folder' AND sh.grantee_id = $1::uuid
                       AND EXISTS (
                           WITH RECURSIVE up AS (
                               SELECT id, parent_id FROM folders WHERE id = f.folder_id AND is_deleted = false
                               UNION ALL
                               SELECT fo.id, fo.parent_id FROM folders fo
                               INNER JOIN up ON fo.id = up.parent_id
                               WHERE fo.is_deleted = false
                           )
                           SELECT 1 FROM up WHERE up.id = sh.resource_id
                       )
                   ))
               )
             ORDER BY s.created_at DESC`,
            [userId]
        );

        const folders = await query(
            `SELECT fol.id, fol.name, fol.parent_id, fol.created_at, fol.updated_at
             FROM stars s
             JOIN folders fol ON fol.id = s.resource_id AND s.resource_type = 'folder'
             WHERE s.user_id = $1
               AND fol.is_deleted = false
               AND (
                   fol.owner_id = $1::uuid
                   OR EXISTS (SELECT 1 FROM shares sh WHERE sh.resource_type = 'folder' AND sh.resource_id = fol.id AND sh.grantee_id = $1::uuid)
                   OR EXISTS (
                       SELECT 1 FROM shares sh
                       WHERE sh.resource_type = 'folder' AND sh.grantee_id = $1::uuid
                       AND EXISTS (
                           WITH RECURSIVE up AS (
                               SELECT id, parent_id FROM folders WHERE id = fol.id AND is_deleted = false
                               UNION ALL
                               SELECT fo.id, fo.parent_id FROM folders fo
                               INNER JOIN up ON fo.id = up.parent_id
                               WHERE fo.is_deleted = false
                           )
                           SELECT 1 FROM up WHERE up.id = sh.resource_id
                       )
                   )
               )
             ORDER BY s.created_at DESC`,
            [userId]
        );

        res.json({ files, folders });
    } catch (err) {
        next(err);
    }
});

// POST /api/stars — favorite a file or folder
starsRouter.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const parsed = StarBodySchema.safeParse(req.body);
        if (!parsed.success) {
            throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid body", 400);
        }
        const { resourceType, resourceId } = parsed.data;

        if (resourceType === "file") {
            const acc = await getFileAccess(userId, resourceId);
            if (!acc) {
                throw new AppError("NOT_FOUND", "File not found", 404);
            }
        } else {
            const acc = await getFolderAccess(userId, resourceId);
            if (!acc) {
                throw new AppError("NOT_FOUND", "Folder not found", 404);
            }
        }

        await query(
            `INSERT INTO stars (user_id, resource_type, resource_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, resource_type, resource_id) DO NOTHING`,
            [userId, resourceType, resourceId]
        );

        res.status(201).json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/stars?resourceType=file&resourceId=...
starsRouter.delete("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const resourceType = req.query.resourceType as string;
        const resourceId = req.query.resourceId as string;
        if (resourceType !== "file" && resourceType !== "folder") {
            throw new AppError("VALIDATION_ERROR", "resourceType must be file or folder", 400);
        }
        const idParsed = z.string().uuid().safeParse(resourceId);
        if (!idParsed.success) {
            throw new AppError("VALIDATION_ERROR", "resourceId must be a UUID", 400);
        }

        await query(
            `DELETE FROM stars
             WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3`,
            [userId, resourceType, resourceId]
        );

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});
