import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import {
    buildStorageKey,
    createPresignedUploadUrl,
    createPresignedDownloadUrl,
    deleteObject,
} from "../services/storage";
import {
    getFileAccess,
    canWriteFileAccess,
    canDeleteResource,
} from "../services/acl";

export const filesRouter = Router();

function paramStr(p: string | string[] | undefined): string {
    if (p === undefined) return "";
    return Array.isArray(p) ? p[0] ?? "" : p;
}

// All file routes require authentication
filesRouter.use(requireAuth);

// Zod schemas - validate request bodies at runtime
const CreateFileSchema = z.object({
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1),
    size: z.number().positive().max(5 * 1024 * 1024 * 1024), // Max 5GB
    folderId: z.string().uuid().nullable().optional(),
});

const CompleteSchema = z.object({
    fileId: z.string().uuid(),
});

// POST /api/files - create a new file record and return a presigned upload URL
filesRouter.post('/init', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = CreateFileSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('Invalid request body', body.error.issues[0].message, 400);
        }

        const { name, mimeType, size, folderId } = body.data;
        const { userId } = req.user!;
        const fileId = uuidv4();

        // Build a consistent storage key for every file
        const storageKey = buildStorageKey(userId, fileId, name);

        // 1. Create DB placeholder - status = 'pending' until upload is complete
        await query(
            `INSERT INTO files
                (id, owner_id, name, mime_type, size_bytes, storage_key, folder_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading')`,
            [fileId, userId, name, mimeType, size, storageKey, folderId ?? null]
        );

        // 2. Generate presigned upload URL - browser will upload directly to storage using this URL
        const uploadUrl = await createPresignedUploadUrl(storageKey);

        res.status(201).json({
            fileId,
            storageKey,
            uploadUrl, // Browser will upload directly to storage using this URL
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/files/complete - called by client after successful upload to update DB record to 'available'
filesRouter.post('/complete', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = CompleteSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('Invalid request body', body.error.issues[0].message, 400);
        }

        const { fileId } = body.data;
        const { userId } = req.user!;

        // Verify this file belongs to the requesting user
        const rows = await query<{
            status: string; id: string, storage_key: string
        }>(
            `SELECT id, status FROM files
            WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
            [fileId, userId]
        );

        if (rows.length === 0) {
            throw new AppError('File not found', 'No file with this ID belongs to the user', 404);
        }
        if (rows[0].status !== 'uploading') {
            throw new AppError('Invalid file status', 'File is not in uploading state', 409);
        }

        // Mark as ready - the file is now available for download
        const files = await query(
            `UPDATE files
            SET status = 'ready', updated_at = now()
            WHERE id = $1
            RETURNING id, name, mime_type, size_bytes, folder_id, created_at`,
            [fileId]
        );
        res.json(files[0]);
    } catch (err) {
        next(err);
    }
});

// GET /api/files/recent — recently updated files (owner only)
filesRouter.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit || "50"), 10) || 50, 1), 100);
        const files = await query(
            `SELECT id, name, mime_type, size_bytes, folder_id, created_at, updated_at
             FROM files
             WHERE owner_id = $1
               AND is_deleted = false
               AND status = 'ready'
             ORDER BY updated_at DESC NULLS LAST
             LIMIT $2`,
            [userId, limit]
        );
        res.json({ files });
    } catch (err) {
        next(err);
    }
});

// GET /api/files - list all files in a folder
filesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const folderId = (req.query.folderId as string) ?? null;

        const files = await query(
            `SELECT id, name, mime_type, size_bytes, folder_id, created_at, updated_at
            FROM files
            WHERE owner_id = $1
               AND is_deleted = false
               AND status = 'ready'
               AND ($2::uuid IS NULL AND folder_id IS NULL OR folder_id = $2::uuid)
            ORDER BY created_at DESC`,
            [userId, folderId]
        );
        res.json(files);
    } catch (err) {
        next(err);
    }
});

// GET /api/files/:fileId - download a file
filesRouter.get('/:fileId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const fileId = paramStr(req.params.fileId);

        const acc = await getFileAccess(userId, fileId);
        if (!acc) {
            throw new AppError('File not found', 'No file with this ID belongs to the user', 404);
        }

        const file = acc.row;

        const signedUrl = await createPresignedDownloadUrl(file.storage_key);

        res.json({
            file: {
                id: file.id,
                name: file.name,
                mimeType: file.mime_type,
                sizeBytes: file.size_bytes,
            },
            downloadUrl: signedUrl,
            access:
                acc.access.kind === 'owner'
                    ? 'owner'
                    : acc.access.role === 'editor'
                      ? 'editor'
                      : 'viewer',
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/files/:fileId - soft delete a file (mark as deleted in DB and remove from storage)
filesRouter.delete('/:fileId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const fileId = paramStr(req.params.fileId);

        const acc = await getFileAccess(userId, fileId);
        if (!acc || !canDeleteResource(acc.access)) {
            throw new AppError('File not found', 'No file with this ID belongs to the user', 404);
        }

        const rows = await query(
            `UPDATE files
            SET is_deleted = true, updated_at = now()
            WHERE id = $1 AND owner_id = $2 AND is_deleted = false
            RETURNING id`,
            [fileId, acc.row.owner_id]
        );

        if (rows.length === 0) {
            throw new AppError('File not found', 'No file with this ID belongs to the user', 404);
        }

        res.json({ message: 'File moved to trash successfully' });
    } catch (err) {
        next(err);
    }
});

// PATCH /api/files/:id - rename or move a file to another folder
filesRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const Schema = z.object({
            name: z.string().min(1).max(255).optional(),
            folderId: z.string().uuid().nullable().optional(),
        });

        const body = Schema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('Invalid request body', body.error.issues[0].message, 400);
        }
        
        const { userId } = req.user!;
        const id = paramStr(req.params.id);
        const { name, folderId } = body.data;

        const acc = await getFileAccess(userId, id);
        if (!acc || !canWriteFileAccess(acc.access)) {
            throw new AppError('NOT_FOUND', 'File not found or already deleted', 404);
        }

        const updated = await query(
            `UPDATE files 
            SET 
                name = COALESCE($1, name),
                folder_id = CASE WHEN $2::boolean THEN $3 ELSE folder_id END,
                updated_at = now()
            WHERE id = $4 AND owner_id = $5 AND is_deleted = false
            RETURNING id, name, folder_id, updated_at`,
            [
                name ?? null,
                folderId !== undefined,
                folderId ?? null,
                id,
                acc.row.owner_id,
            ]
    );

    if (updated.length === 0) {
        throw new AppError('NOT_FOUND', 'File not found or already deleted', 404);
    }

    res.json({file: updated[0]});
    } catch (err) {
        next(err);
    }
});