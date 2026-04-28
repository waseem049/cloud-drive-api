import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import {
    getFolderAccess,
    canWriteFolderAccess,
    canDeleteResource,
} from "../services/acl";


export const foldersRouter = Router();

function paramStr(p: string | string[] | undefined): string {
    if (p === undefined) return "";
    return Array.isArray(p) ? p[0] ?? "" : p;
}

// All folder routes require authentication
foldersRouter.use(requireAuth);

// Schemas
const CreateFolderSchema = z.object({
    name: z.string().min(1).max(255),
    parentId: z.string().uuid().nullable().optional(),
});

const UpdateFolderSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    parentId: z.string().uuid().nullable().optional(),
});

// Cycle detection helper - checks if moving folder would create a cycle in the hierarchy
// Before moving folder A into folder B, we need to ensure that B is not a descendant of A
async function wouldCreateCycle(
    movingFolderId: string,
    targetParentId: string
): Promise<boolean> {
    const rows = await query<{ id: string }>(
        `WITH RECURSIVE descendants AS (
            SELECT id FROM folders WHERE parent_id = $1
            UNION ALL
            SELECT f.id FROM folders f
            JOIN descendants d ON f.parent_id = d.id
        )
        SELECT id FROM descendants WHERE id = $2`,
        [movingFolderId, targetParentId]
    );
    return rows.length > 0; // If we find the target parent in the descendants of the moving folder, it would create a cycle
}

// Build breadcrumb path for a folder - used in responses to show full path
async function getFolderPath(
    folderId: string | string[]
): Promise<Array<{ id: string, name: string }>> {
    const id = Array.isArray(folderId) ? folderId[0] : folderId;
    const rows = await query<{ id: string, name: string }>(
        `WITH RECURSIVE path AS (
            SELECT id, name, parent_id FROM folders WHERE id = $1
            UNION ALL
            SELECT f.id, f.name, f.parent_id FROM folders f
            JOIN path p ON f.id = p.parent_id
        )
        SELECT id, name FROM path`,
        [id]
    );
    return rows.reverse(); // Reverse to get path from root to current folder
}

// POST /api/folders - create a new folder
foldersRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = CreateFolderSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('VALIDATION_ERROR', body.error.issues[0].message, 400);
        }

        const { name, parentId } = body.data;
        const { userId } = req.user!;

        // If parentId is provided, verify it exists and belongs to the user
        if (parentId) {
            const parent = await query(
                `SELECT id FROM folders
                WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
                [parentId, userId]
            );
            if (parent.length === 0) {
                throw new AppError('VALIDATION_ERROR', 'Parent folder not found', 400);
            }
        }

        const folders = await query(
            `INSERT INTO folders (name, parent_id, owner_id)
            VALUES ($1, $2, $3)
            RETURNING id, name, parent_id, created_at`,
            [name, parentId, userId ?? null]
        );

        res.status(201).json({ folder: folders[0] });
    } catch (err: any) {
        // Unique constraint violation - duplicate name in same directory
        if (err.code === '23505') {
            return next(new AppError('CONFLICT', 'A folder with this name already exists in the target directory', 409));
        }
        next(err);
    }
});

// GET /api/folders/:id - get folder contents + breadcrumbs
// Use 'root' as the id to get root-level contents
foldersRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const rawId = paramStr(req.params.id);
        const folderId = rawId === "root" ? null : rawId;

        if (folderId === null) {
            const folders = await query(
                `SELECT id, name, parent_id, created_at, updated_at
                 FROM folders
                 WHERE owner_id = $1
                   AND is_deleted = false
                   AND parent_id IS NULL
                 ORDER BY name ASC`,
                [userId]
            );
            const files = await query(
                `SELECT id, name, mime_type, size_bytes, folder_id, status, created_at, updated_at
                 FROM files
                 WHERE owner_id = $1
                   AND is_deleted = false
                   AND status = 'ready'
                   AND folder_id IS NULL
                 ORDER BY created_at DESC`,
                [userId]
            );
            res.json({ folders, files, path: [], access: 'owner' });
            return;
        }

        const access = await getFolderAccess(userId, folderId);
        if (!access) {
            throw new AppError('NOT_FOUND', 'Folder not found', 404);
        }

        const ownerId = access.row.owner_id;
        const accessLabel =
            access.access.kind === 'owner'
                ? 'owner'
                : access.access.role === 'editor'
                  ? 'editor'
                  : 'viewer';

        const folders = await query(
            `SELECT id, name, parent_id, created_at, updated_at
             FROM folders
             WHERE owner_id = $1
               AND is_deleted = false
               AND parent_id = $2::uuid
             ORDER BY name ASC`,
            [ownerId, folderId]
        );

        const files = await query(
            `SELECT id, name, mime_type, size_bytes, folder_id, status, created_at, updated_at
             FROM files
             WHERE owner_id = $1
               AND is_deleted = false
               AND status = 'ready'
               AND folder_id = $2::uuid
             ORDER BY created_at DESC`,
            [ownerId, folderId]
        );

        const path = await getFolderPath(folderId);

        res.json({ folders, files, path, access: accessLabel });
    } catch (err) {
        next(err);
    }
});

// PATCH /api/folders/:id - rename or move a folder
foldersRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = UpdateFolderSchema.safeParse(req.body);
        if (!body.success) {
            throw new AppError('VALIDATION_ERROR', body.error.issues[0].message, 400);
        }

        const { userId } = req.user!;
        const id = paramStr(req.params.id);
        const { name, parentId } = body.data;

        const fa = await getFolderAccess(userId, id);
        if (!fa || !canWriteFolderAccess(fa.access)) {
            throw new AppError('NOT_FOUND', 'Folder not found', 404);
        }
        const existing = await query(
            `SELECT id, parent_id FROM folders
            WHERE id = $1 AND is_deleted = false`,
            [id]
        );
        if (existing.length === 0) {
            throw new AppError('NOT_FOUND', 'Folder not found', 404);
        }

        // Cycle detection - only needed if moving (parentId is changing)
        if (parentId !== undefined && parentId !== null) {
            const cycle = await wouldCreateCycle(id, parentId);
            if (cycle) {
                throw new AppError(
                    'CONFLICT',
                    'Cannot move folder into one of its own subfolders (would create a cycle)',
                    409
                );
            }
        }

        const ownerId = fa.row.owner_id;
        const updated = await query(
            `UPDATE folders
            SET 
                name = COALESCE($1, name),
                parent_id = CASE WHEN $2::boolean THEN $3::uuid ELSE parent_id END,
                updated_at = now()
            WHERE id = $4 AND owner_id = $5 
            RETURNING id, name, parent_id, created_at, updated_at`,
            [
                name ?? null,
                parentId !== undefined,
                parentId ?? null,
                id,
                ownerId,
            ]
        );

        res.json({ folder: updated[0] });
    } catch (err: any) {
        if (err.code === '23505') {
            return next(new AppError('CONFLICT', 'A folder with this name already exists in the target directory', 409));
        }
        next(err);
    }
});

// DELETE /api/folders/:id - soft delete a folder and all its contents
foldersRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const id = paramStr(req.params.id);

        const fa = await getFolderAccess(userId, id);
        if (!fa || !canDeleteResource(fa.access)) {
            throw new AppError('NOT_FOUND', 'Folder not found', 404);
        }

        const existing = await query(
            `SELECT id FROM folders
            WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
            [id, fa.row.owner_id]
        );
        if (existing.length === 0) {
            throw new AppError('NOT_FOUND', 'Folder not found', 404);
        }

        // Soft delete the folder and all its descendants (subfolders and files)
        await query(
            `WITH RECURSIVE to_delete AS (
                SELECT id FROM folders WHERE id = $1
                UNION ALL
                SELECT f.id FROM folders f
                JOIN to_delete d ON f.parent_id = d.id
            )
            UPDATE folders
            SET is_deleted = true, updated_at = now()
            WHERE id IN (SELECT id FROM to_delete)`,
            [id]
        );

        // Soft delete all files inside this folder tree
        await query(
            `WITH RECURSIVE descendants AS (
                SELECT id FROM folders WHERE id = $1
                UNION ALL
                SELECT f.id FROM folders f
                JOIN descendants d ON f.parent_id = d.id
            )
            UPDATE files SET is_deleted = true, updated_at = now()
            WHERE folder_id IN (SELECT id FROM descendants)`,
            [id]
        );

        res.json({ message: 'Folder moved to trash' });
    } catch (err) {
        next(err);
    }
});