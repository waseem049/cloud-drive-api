import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";

export const storageRouter = Router();
storageRouter.use(requireAuth);

const STORAGE_LIMIT_BYTES = 15 * 1024 * 1024 * 1024; // 15 GB default

// GET /api/storage - get user's storage usage
storageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;

        const rows = await query<{ used_bytes: string; file_count: string }>(
            `SELECT 
                COALESCE(SUM(size_bytes), 0) AS used_bytes,
                COUNT(*)::text AS file_count
             FROM files
             WHERE owner_id = $1
               AND is_deleted = false
               AND status = 'ready'`,
            [userId]
        );

        const usedBytes = parseInt(rows[0].used_bytes, 10);
        const fileCount = parseInt(rows[0].file_count, 10);

        res.json({
            usedBytes,
            limitBytes: STORAGE_LIMIT_BYTES,
            fileCount,
            percentUsed: Math.round((usedBytes / STORAGE_LIMIT_BYTES) * 10000) / 100,
        });
    } catch (err) {
        next(err);
    }
});
