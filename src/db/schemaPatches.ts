import { query } from "./client";

/**
 * Idempotent DDL so local/staging servers work without manually running SQL files.
 * Safe to call on every boot (IF NOT EXISTS).
 */
export async function applyIdempotentSchemaPatches(): Promise<void> {
    // Needed for gen_random_uuid()
    await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Core auth tables
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            image_url TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS user_credentials (
            user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // Drive hierarchy
    await query(`
        CREATE TABLE IF NOT EXISTS folders (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            parent_id UUID REFERENCES folders(id) ON DELETE SET NULL,
            is_deleted BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (owner_id, parent_id, name)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS files (
            id UUID PRIMARY KEY,
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            storage_key TEXT NOT NULL,
            folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'uploading',
            is_deleted BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_files_owner_folder ON files(owner_id, folder_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_folders_owner_parent ON folders(owner_id, parent_id)`);

    // Sharing (per-user access grants)
    await query(`
        CREATE TABLE IF NOT EXISTS shares (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            resource_type TEXT NOT NULL,
            resource_id UUID NOT NULL,
            grantee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            granted_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (resource_type, resource_id, grantee_id)
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_shares_resource ON shares(resource_type, resource_id)`);

    // Public share links (token-based)
    await query(`
        CREATE TABLE IF NOT EXISTS shared_links (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            token TEXT NOT NULL UNIQUE,
            created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (file_id, created_by)
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token)`);

    // Stars / favorites
    await query(`
        CREATE TABLE IF NOT EXISTS stars (
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            resource_type TEXT NOT NULL,
            resource_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (user_id, resource_type, resource_id)
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_stars_user ON stars(user_id)`);

    // Password reset (references users)
    await query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            used_at TIMESTAMPTZ
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash
        ON password_reset_tokens(token_hash)
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_password_reset_user_id
        ON password_reset_tokens(user_id)
    `);
}
