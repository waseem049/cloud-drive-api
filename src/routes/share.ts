import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { createPresignedDownloadUrl } from "../services/storage";

export const shareRouter = Router();

const CreateShareSchema = z.object({
    expiresInHours: z.number().min(1).max(720).default(168), // default 7 days
});

const GrantShareSchema = z.object({
    resourceType: z.enum(["file", "folder"]),
    resourceId: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(["viewer", "editor"]),
});

// POST /api/shares — grant access to a user by email (resource owner only)
shareRouter.post("/shares", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const parsed = GrantShareSchema.safeParse(req.body);
        if (!parsed.success) {
            throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid body", 400);
        }
        const { resourceType, resourceId, email, role } = parsed.data;
        const emailLower = email.toLowerCase();

        const grantees = await query<{ id: string }>(
            `SELECT id FROM users WHERE email = $1`,
            [emailLower]
        );
        if (grantees.length === 0) {
            throw new AppError("NOT_FOUND", "No user with that email", 404);
        }
        const granteeId = grantees[0].id;
        if (granteeId === userId) {
            throw new AppError("VALIDATION_ERROR", "Cannot share with yourself", 400);
        }

        if (resourceType === "file") {
            const rows = await query<{ id: string }>(
                `SELECT id FROM files WHERE id = $1 AND owner_id = $2 AND is_deleted = false AND status = 'ready'`,
                [resourceId, userId]
            );
            if (rows.length === 0) {
                throw new AppError("NOT_FOUND", "File not found", 404);
            }
        } else {
            const rows = await query<{ id: string }>(
                `SELECT id FROM folders WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
                [resourceId, userId]
            );
            if (rows.length === 0) {
                throw new AppError("NOT_FOUND", "Folder not found", 404);
            }
        }

        const inserted = await query<{ id: string }>(
            `INSERT INTO shares (resource_type, resource_id, grantee_id, granted_by, role)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (resource_type, resource_id, grantee_id)
             DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by
             RETURNING id`,
            [resourceType, resourceId, granteeId, userId, role]
        );

        res.status(201).json({ id: inserted[0].id, granteeEmail: emailLower, role });
    } catch (err) {
        next(err);
    }
});

// GET /api/shares/:resourceType/:resourceId — list users with access (owner only)
shareRouter.get(
    "/shares/:resourceType/:resourceId",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { userId } = req.user!;
            const resourceType = req.params.resourceType;
            const resourceId = req.params.resourceId;
            if (resourceType !== "file" && resourceType !== "folder") {
                throw new AppError("VALIDATION_ERROR", "resourceType must be file or folder", 400);
            }

            if (resourceType === "file") {
                const rows = await query(
                    `SELECT id FROM files WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
                    [resourceId, userId]
                );
                if (rows.length === 0) {
                    throw new AppError("NOT_FOUND", "File not found", 404);
                }
            } else {
                const rows = await query(
                    `SELECT id FROM folders WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
                    [resourceId, userId]
                );
                if (rows.length === 0) {
                    throw new AppError("NOT_FOUND", "Folder not found", 404);
                }
            }

            const shares = await query<{
                id: string;
                role: string;
                created_at: string;
                grantee_email: string;
                grantee_name: string | null;
            }>(
                `SELECT s.id, s.role, s.created_at, u.email AS grantee_email, u.name AS grantee_name
                 FROM shares s
                 JOIN users u ON u.id = s.grantee_id
                 WHERE s.resource_type = $1 AND s.resource_id = $2
                 ORDER BY s.created_at ASC`,
                [resourceType, resourceId]
            );

            res.json({ shares });
        } catch (err) {
            next(err);
        }
    }
);

// DELETE /api/shares/:id — revoke access (original granter or resource owner)
shareRouter.delete("/shares/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const shareId = req.params.id;

        const rows = await query<{
            id: string;
            resource_type: string;
            resource_id: string;
            granted_by: string;
        }>(
            `SELECT id, resource_type, resource_id, granted_by FROM shares WHERE id = $1`,
            [shareId]
        );
        if (rows.length === 0) {
            throw new AppError("NOT_FOUND", "Share not found", 404);
        }
        const row = rows[0];

        let isOwner = false;
        if (row.resource_type === "file") {
            const f = await query(
                `SELECT id FROM files WHERE id = $1 AND owner_id = $2`,
                [row.resource_id, userId]
            );
            isOwner = f.length > 0;
        } else {
            const f = await query(
                `SELECT id FROM folders WHERE id = $1 AND owner_id = $2`,
                [row.resource_id, userId]
            );
            isOwner = f.length > 0;
        }

        if (!isOwner && row.granted_by !== userId) {
            throw new AppError("FORBIDDEN", "Not allowed to revoke this share", 403);
        }

        await query(`DELETE FROM shares WHERE id = $1`, [shareId]);
        res.json({ message: "Access revoked" });
    } catch (err) {
        next(err);
    }
});

// POST /api/files/:fileId/share - create a share link (requires auth)
shareRouter.post('/files/:fileId/share', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const fileId = req.params.fileId;

        const body = CreateShareSchema.safeParse(req.body || {});
        const expiresInHours = body.success ? body.data.expiresInHours : 168;

        // Verify file ownership
        const files = await query<{ id: string; name: string; storage_key: string }>(
            `SELECT id, name, storage_key FROM files
             WHERE id = $1 AND owner_id = $2 AND is_deleted = false AND status = 'ready'`,
            [fileId, userId]
        );

        if (files.length === 0) {
            throw new AppError('NOT_FOUND', 'File not found', 404);
        }

        const token = uuidv4();
        const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

        // Create or update share link
        await query(
            `INSERT INTO shared_links (id, file_id, token, created_by, expires_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4)
             ON CONFLICT (file_id, created_by) 
             DO UPDATE SET token = $2, expires_at = $4, created_at = now()`,
            [fileId, token, userId, expiresAt.toISOString()]
        );

        res.status(201).json({
            shareToken: token,
            expiresAt: expiresAt.toISOString(),
            shareUrl: `/shared/${token}`,
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/files/:fileId/share - revoke share link (requires auth)
shareRouter.delete('/files/:fileId/share', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const fileId = req.params.fileId;

        await query(
            `DELETE FROM shared_links WHERE file_id = $1 AND created_by = $2`,
            [fileId, userId]
        );

        res.json({ message: 'Share link revoked' });
    } catch (err) {
        next(err);
    }
});

// GET /api/shared/:token - access shared file (NO auth required)
shareRouter.get('/shared/:token', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { token } = req.params;

        const rows = await query<{
            file_id: string; file_name: string; mime_type: string;
            size_bytes: number; storage_key: string; expires_at: string;
        }>(
            `SELECT sl.file_id, f.name AS file_name, f.mime_type, f.size_bytes, 
                    f.storage_key, sl.expires_at
             FROM shared_links sl
             JOIN files f ON f.id = sl.file_id
             WHERE sl.token = $1
               AND f.is_deleted = false
               AND f.status = 'ready'`,
            [token]
        );

        if (rows.length === 0) {
            throw new AppError('NOT_FOUND', 'Share link not found or expired', 404);
        }

        const share = rows[0];

        // Check expiration
        if (new Date(share.expires_at) < new Date()) {
            throw new AppError('GONE', 'This share link has expired', 410);
        }

        const downloadUrl = await createPresignedDownloadUrl(share.storage_key);

        res.json({
            file: {
                name: share.file_name,
                mimeType: share.mime_type,
                sizeBytes: share.size_bytes,
            },
            downloadUrl,
        });
    } catch (err) {
        next(err);
    }
});
