-- Migration 079: Rename tools -> capabilities (additive create + backfill)
-- Part of #923 (Epic #922 — Unify Agent Platform)
--
-- The legacy `tools` table is a misnomer: it is a role-gated registry of UI
-- features (Nexus access, Assistant Architect access, admin pages, etc.), not a
-- catalog of invocable tools. This migration introduces the clearer `capability`
-- name without breaking the existing `hasToolAccess()` paths.
--
-- This migration is ADDITIVE and idempotent:
--   1. Create `capabilities` (mirrors `tools` plus a `source` column).
--   2. Create `role_capabilities` (mirrors `role_tools`, using `capability_id`).
--   3. Backfill both new tables from the legacy tables, preserving `id` values so
--      existing role grants and `prompt_chain_tool_id` references stay consistent.
--   4. Re-sync the identity sequences so future INSERTs do not collide with
--      backfilled ids.
--
-- The legacy `tools`/`role_tools` tables are intentionally LEFT IN PLACE — they
-- are dropped in workstream #6 after every `hasToolAccess()` call site is renamed.
--
-- All backfilled rows are marked `source = 'manual'`. The code manifest sync
-- (lib/capabilities/manifest.ts, run on app boot) flips manifest-managed rows to
-- `source = 'code'` after deploy. Marking everything `manual` first is safe: it
-- preserves full editability until the manifest claims ownership.
--
-- NOTE: No PL/pgSQL triggers / DO $$ blocks. The RDS Data API migration runner's
-- statement splitter cannot handle dollar-quoted blocks, and CREATE TRIGGER /
-- CREATE FUNCTION both fail. The capabilities.updated_at column is maintained by
-- application code (Drizzle .set({ updatedAt: new Date() })), matching the legacy
-- tools table behavior.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '079-rename-tools-to-capabilities.sql' AND status = 'failed';

-- 1. capabilities table (mirrors tools + source column)
CREATE TABLE IF NOT EXISTS capabilities (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true NOT NULL,
    source VARCHAR(20) DEFAULT 'manual' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    prompt_chain_tool_id INTEGER,
    CONSTRAINT capabilities_source_check CHECK (source IN ('code', 'manual'))
);

-- 2. role_capabilities join table (mirrors role_tools, capability_id FK)
CREATE TABLE IF NOT EXISTS role_capabilities (
    id SERIAL PRIMARY KEY,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    capability_id INTEGER REFERENCES capabilities(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    UNIQUE(role_id, capability_id)
);

-- 3a. Backfill capabilities from tools, preserving ids.
INSERT INTO capabilities (id, identifier, name, description, is_active, source, created_at, updated_at, prompt_chain_tool_id)
SELECT t.id, t.identifier, t.name, t.description, t.is_active, 'manual', t.created_at, t.updated_at, t.prompt_chain_tool_id
FROM tools t
WHERE NOT EXISTS (
    SELECT 1 FROM capabilities c WHERE c.identifier = t.identifier
);

-- 3b. Backfill role_capabilities from role_tools, preserving ids and grants.
INSERT INTO role_capabilities (id, role_id, capability_id, created_at)
SELECT rt.id, rt.role_id, rt.tool_id, rt.created_at
FROM role_tools rt
WHERE NOT EXISTS (
    SELECT 1 FROM role_capabilities rc
    WHERE rc.role_id = rt.role_id AND rc.capability_id = rt.tool_id
);

-- 4. Indexes (match the legacy tools/role_tools indexes).
CREATE INDEX IF NOT EXISTS idx_role_capabilities_role_id ON role_capabilities(role_id);
CREATE INDEX IF NOT EXISTS idx_role_capabilities_capability_id ON role_capabilities(capability_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_identifier ON capabilities(identifier);
CREATE INDEX IF NOT EXISTS idx_capabilities_is_active ON capabilities(is_active);
CREATE INDEX IF NOT EXISTS idx_capabilities_source ON capabilities(source);

-- 5. Re-sync identity sequences so future INSERTs continue past backfilled ids.
SELECT setval(pg_get_serial_sequence('capabilities', 'id'), COALESCE((SELECT MAX(id) FROM capabilities), 1), true);
SELECT setval(pg_get_serial_sequence('role_capabilities', 'id'), COALESCE((SELECT MAX(id) FROM role_capabilities), 1), true);
