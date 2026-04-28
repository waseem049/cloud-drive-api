import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const searchRouter = Router();
searchRouter.use(requireAuth);

const FILE_ACCESS_SQL = `(
    files.owner_id = $1::uuid
    OR EXISTS (
        SELECT 1 FROM shares s
        WHERE s.resource_type = 'file' AND s.resource_id = files.id AND s.grantee_id = $1::uuid
    )
    OR (
        files.folder_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM shares s
            WHERE s.resource_type = 'folder' AND s.grantee_id = $1::uuid
            AND EXISTS (
                WITH RECURSIVE up AS (
                    SELECT id, parent_id FROM folders WHERE id = files.folder_id AND is_deleted = false
                    UNION ALL
                    SELECT f.id, f.parent_id FROM folders f
                    INNER JOIN up ON f.id = up.parent_id
                    WHERE f.is_deleted = false
                )
                SELECT 1 FROM up WHERE up.id = s.resource_id
            )
        )
    )
)`;

const FOLDER_ACCESS_SQL = `(
    folders.owner_id = $1::uuid
    OR EXISTS (
        SELECT 1 FROM shares s
        WHERE s.resource_type = 'folder' AND s.resource_id = folders.id AND s.grantee_id = $1::uuid
    )
    OR EXISTS (
        SELECT 1 FROM shares s
        WHERE s.resource_type = 'folder' AND s.grantee_id = $1::uuid
        AND EXISTS (
            WITH RECURSIVE up AS (
                SELECT id, parent_id FROM folders WHERE id = folders.id AND is_deleted = false
                UNION ALL
                SELECT f.id, f.parent_id FROM folders f
                INNER JOIN up ON f.id = up.parent_id
                WHERE f.is_deleted = false
            )
            SELECT 1 FROM up WHERE up.id = s.resource_id
        )
    )
)`;

function decodeCursor(raw: string | undefined): { createdAt: string; id: string } | null {
    if (!raw) return null;
    try {
        const json = Buffer.from(raw, "base64url").toString("utf8");
        const o = JSON.parse(json) as { c?: string; i?: string };
        if (!o.c || !o.i) return null;
        return { createdAt: o.c, id: o.i };
    } catch {
        return null;
    }
}

function encodeCursor(createdAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAt, i: id }), "utf8").toString("base64url");
}

// GET /api/search?q=...&type=mime substring&starred=true|false&limit=&cursor=
searchRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.user!;
        const q = (req.query.q as string)?.trim();
        if (!q || q.length < 1) {
            throw new AppError("VALIDATION_ERROR", "Search query is required", 400);
        }

        const limit = Math.min(Math.max(parseInt(String(req.query.limit || "20"), 10) || 20, 1), 50);
        const starredRaw = req.query.starred;
        const starredFilter =
            starredRaw === "true" ? true : starredRaw === "false" ? false : undefined;
        const mimeFilter = (req.query.type as string)?.trim() || undefined;

        const cur = decodeCursor(req.query.cursor as string | undefined);
        const cursorTs = cur?.createdAt ?? null;
        const cursorId = cur?.id ?? null;

        const starFileClause =
            starredFilter === true
                ? `AND EXISTS (
                       SELECT 1 FROM stars st
                       WHERE st.user_id = $1::uuid AND st.resource_type = 'file' AND st.resource_id = files.id
                   )`
                : starredFilter === false
                  ? `AND NOT EXISTS (
                       SELECT 1 FROM stars st
                       WHERE st.user_id = $1::uuid AND st.resource_type = 'file' AND st.resource_id = files.id
                   )`
                  : "";

        const starFolderClause =
            starredFilter === true
                ? `AND EXISTS (
                       SELECT 1 FROM stars st
                       WHERE st.user_id = $1::uuid AND st.resource_type = 'folder' AND st.resource_id = folders.id
                   )`
                : starredFilter === false
                  ? `AND NOT EXISTS (
                       SELECT 1 FROM stars st
                       WHERE st.user_id = $1::uuid AND st.resource_type = 'folder' AND st.resource_id = folders.id
                   )`
                  : "";

        const paramsFiles: unknown[] = [userId, q];
        let p = 3;
        let mimeClause = "";
        if (mimeFilter) {
            mimeClause = `AND files.mime_type ILIKE $${p}`;
            paramsFiles.push(`%${mimeFilter}%`);
            p++;
        }

        let cursorClause = "";
        if (cursorTs && cursorId) {
            cursorClause = `AND (files.created_at, files.id) < ($${p}::timestamptz, $${p + 1}::uuid)`;
            paramsFiles.push(cursorTs, cursorId);
            p += 2;
        }

        const filesSql = `
            SELECT files.id, files.name, files.mime_type, files.size_bytes, files.folder_id,
                   files.created_at, files.updated_at,
                   EXISTS (
                       SELECT 1 FROM stars st
                       WHERE st.user_id = $1::uuid AND st.resource_type = 'file' AND st.resource_id = files.id
                   ) AS starred
            FROM files
            WHERE files.is_deleted = false AND files.status = 'ready'
              AND ${FILE_ACCESS_SQL}
              AND (
                  files.name_tsv @@ plainto_tsquery('english', $2)
                  OR files.name ILIKE '%' || $2 || '%'
                  OR similarity(files.name, $2) > 0.12
              )
              ${mimeClause}
              ${starFileClause}
              ${cursorClause}
            ORDER BY files.created_at DESC, files.id DESC
            LIMIT ${limit + 1}
        `;

        const paramsFolders: unknown[] = [userId, q];
        let pf = 3;
        let cursorClauseFolders = "";
        if (cursorTs && cursorId) {
            cursorClauseFolders = `AND (folders.created_at, folders.id) < ($${pf}::timestamptz, $${pf + 1}::uuid)`;
            paramsFolders.push(cursorTs, cursorId);
            pf += 2;
        }

        const foldersSql = `
            SELECT folders.id, folders.name, folders.parent_id, folders.created_at, folders.updated_at,
                   EXISTS (
                       SELECT 1 FROM stars st
                       WHERE st.user_id = $1::uuid AND st.resource_type = 'folder' AND st.resource_id = folders.id
                   ) AS starred
            FROM folders
            WHERE folders.is_deleted = false
              AND ${FOLDER_ACCESS_SQL}
              AND (
                  folders.name_tsv @@ plainto_tsquery('english', $2)
                  OR folders.name ILIKE '%' || $2 || '%'
                  OR similarity(folders.name, $2) > 0.12
              )
              ${starFolderClause}
              ${cursorClauseFolders}
            ORDER BY folders.created_at DESC, folders.id DESC
            LIMIT ${limit + 1}
        `;

        const [fileRows, folderRows] = await Promise.all([
            query<{
                id: string;
                name: string;
                mime_type: string;
                size_bytes: number;
                folder_id: string | null;
                created_at: string;
                updated_at: string;
                starred: boolean;
            }>(filesSql, paramsFiles),
            query<{
                id: string;
                name: string;
                parent_id: string | null;
                created_at: string;
                updated_at: string;
                starred: boolean;
            }>(foldersSql, paramsFolders),
        ]);

        const fileHasMore = fileRows.length > limit;
        const folderHasMore = folderRows.length > limit;
        const filesOut = (fileHasMore ? fileRows.slice(0, limit) : fileRows).map((r) => ({
            id: r.id,
            name: r.name,
            mime_type: r.mime_type,
            size_bytes: r.size_bytes,
            folder_id: r.folder_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
            starred: r.starred,
        }));
        const foldersOut = (folderHasMore ? folderRows.slice(0, limit) : folderRows).map((r) => ({
            id: r.id,
            name: r.name,
            parent_id: r.parent_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
            starred: r.starred,
        }));

        let nextCursor: string | null = null;
        const lastFile = filesOut[filesOut.length - 1];
        const lastFolder = foldersOut[foldersOut.length - 1];
        const lastTs =
            !lastFile && !lastFolder
                ? null
                : !lastFile
                  ? lastFolder!.created_at
                  : !lastFolder
                    ? lastFile.created_at
                    : lastFile.created_at > lastFolder.created_at
                      ? lastFile.created_at
                      : lastFolder.created_at;
        const lastId =
            !lastFile && !lastFolder
                ? null
                : !lastFile
                  ? lastFolder!.id
                  : !lastFolder
                    ? lastFile.id
                    : lastFile.created_at > lastFolder.created_at
                      ? lastFile.id
                      : lastFolder.id;

        if ((fileHasMore || folderHasMore) && lastTs && lastId) {
            nextCursor = encodeCursor(lastTs, lastId);
        }

        res.json({
            files: filesOut,
            folders: foldersOut,
            query: q,
            nextCursor,
            hasMore: fileHasMore || folderHasMore,
        });
    } catch (err) {
        next(err);
    }
});
