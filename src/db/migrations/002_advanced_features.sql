-- Day 5–6: per-user shares, stars, search indexes (run in Supabase SQL editor after 001)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Per-user ACL: grantee may be viewer or editor on a file or folder
CREATE TABLE IF NOT EXISTS shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
    resource_id UUID NOT NULL,
    grantee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resource_type, resource_id, grantee_id)
);

CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_id);
CREATE INDEX IF NOT EXISTS idx_shares_resource ON shares(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_shares_granted_by ON shares(granted_by);

CREATE TABLE IF NOT EXISTS stars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
    resource_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_stars_user ON stars(user_id);
CREATE INDEX IF NOT EXISTS idx_stars_resource ON stars(resource_type, resource_id);

-- Fuzzy name search (pg_trgm)
CREATE INDEX IF NOT EXISTS idx_files_name_trgm ON files USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_folders_name_trgm ON folders USING gin (name gin_trgm_ops);

-- Full-text search on names
ALTER TABLE files ADD COLUMN IF NOT EXISTS name_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, ''))) STORED;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS name_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_files_name_tsv ON files USING gin (name_tsv);
CREATE INDEX IF NOT EXISTS idx_folders_name_tsv ON folders USING gin (name_tsv);
