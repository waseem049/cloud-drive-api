import { query } from "../db/client";

export type ShareRole = "viewer" | "editor";

const ROLE_RANK: Record<ShareRole, number> = { viewer: 1, editor: 2 };

function strongest(a: ShareRole | null, b: ShareRole | null): ShareRole | null {
    if (!a) return b;
    if (!b) return a;
    return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** Best matching share role for grantee on any of the given folder ids (direct shares on those folders). */
async function bestFolderShareRole(
    granteeId: string,
    folderIds: string[]
): Promise<ShareRole | null> {
    if (folderIds.length === 0) return null;
    const rows = await query<{ role: ShareRole }>(
        `SELECT role FROM shares
         WHERE grantee_id = $1 AND resource_type = 'folder' AND resource_id = ANY($2::uuid[])`,
        [granteeId, folderIds]
    );
    let best: ShareRole | null = null;
    for (const r of rows) {
        best = strongest(best, r.role);
    }
    return best;
}

/** Walk from folder_id up to root; return ids from current folder to root inclusive. */
async function folderAncestorIds(folderId: string): Promise<string[]> {
    const rows = await query<{ id: string }>(
        `WITH RECURSIVE up AS (
            SELECT id, parent_id FROM folders WHERE id = $1 AND is_deleted = false
            UNION ALL
            SELECT f.id, f.parent_id FROM folders f
            INNER JOIN up ON f.id = up.parent_id
            WHERE f.is_deleted = false
        )
        SELECT id FROM up`,
        [folderId]
    );
    return rows.map((r) => r.id);
}

export type FileAccess =
    | { kind: "owner"; ownerId: string }
    | { kind: "grantee"; ownerId: string; role: ShareRole };

export async function getFileAccess(
    userId: string,
    fileId: string
): Promise<
    | { access: FileAccess; row: { id: string; owner_id: string; folder_id: string | null; storage_key: string; name: string; mime_type: string; size_bytes: number } }
    | null
> {
    const files = await query<{
        id: string;
        owner_id: string;
        folder_id: string | null;
        storage_key: string;
        name: string;
        mime_type: string;
        size_bytes: number;
    }>(
        `SELECT id, owner_id, folder_id, storage_key, name, mime_type, size_bytes
         FROM files
         WHERE id = $1 AND is_deleted = false AND status = 'ready'`,
        [fileId]
    );
    if (files.length === 0) return null;
    const file = files[0];

    if (file.owner_id === userId) {
        return { access: { kind: "owner", ownerId: file.owner_id }, row: file };
    }

    const direct = await query<{ role: ShareRole }>(
        `SELECT role FROM shares
         WHERE grantee_id = $1 AND resource_type = 'file' AND resource_id = $2`,
        [userId, fileId]
    );
    let best: ShareRole | null = direct[0]?.role ?? null;

    if (file.folder_id) {
        const ancestors = await folderAncestorIds(file.folder_id);
        best = strongest(best, await bestFolderShareRole(userId, ancestors));
    }

    if (!best) return null;
    return { access: { kind: "grantee", ownerId: file.owner_id, role: best }, row: file };
}

export type FolderAccess =
    | { kind: "owner"; ownerId: string }
    | { kind: "grantee"; ownerId: string; role: ShareRole };

export async function getFolderAccess(
    userId: string,
    folderId: string
): Promise<
    | { access: FolderAccess; row: { id: string; owner_id: string; parent_id: string | null; name: string } }
    | null
> {
    const folders = await query<{
        id: string;
        owner_id: string;
        parent_id: string | null;
        name: string;
    }>(
        `SELECT id, owner_id, parent_id, name FROM folders
         WHERE id = $1 AND is_deleted = false`,
        [folderId]
    );
    if (folders.length === 0) return null;
    const folder = folders[0];

    if (folder.owner_id === userId) {
        return { access: { kind: "owner", ownerId: folder.owner_id }, row: folder };
    }

    const ancestors = await folderAncestorIds(folderId);
    const best = await bestFolderShareRole(userId, ancestors);
    if (!best) return null;
    return { access: { kind: "grantee", ownerId: folder.owner_id, role: best }, row: folder };
}

export function canReadFileAccess(access: FileAccess): boolean {
    return true;
}

export function canWriteFileAccess(access: FileAccess): boolean {
    return access.kind === "owner" || (access.kind === "grantee" && access.role === "editor");
}

export function canDeleteResource(access: FileAccess | FolderAccess): boolean {
    return access.kind === "owner";
}

export function canWriteFolderAccess(access: FolderAccess): boolean {
    return access.kind === "owner" || (access.kind === "grantee" && access.role === "editor");
}
