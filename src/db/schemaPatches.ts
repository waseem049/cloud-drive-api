import { query } from "./client";

/**
 * Idempotent DDL so local/staging servers work without manually running SQL files.
 * Safe to call on every boot (IF NOT EXISTS).
 */
export async function applyIdempotentSchemaPatches(): Promise<void> {
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
