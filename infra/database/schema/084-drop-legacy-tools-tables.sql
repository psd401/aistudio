-- Migration 084: Drop the legacy tools / role_tools tables
-- Workstream #6 of Epic #922 (Issue #928) — completes the tools -> capabilities
-- rename started in migration 079.
--
-- Migration 079 created `capabilities` / `role_capabilities` and backfilled them
-- from `tools` / `role_tools`, leaving the legacy tables in place so the
-- `hasToolAccess()` call sites kept working. Issue #928 migrated every call site
-- to `hasCapabilityAccess()` and removed the compat shim, so the legacy tables
-- are now unreferenced by application code and can be dropped.
--
-- Order of operations:
--   1. Re-point navigation_items from tools(id) to capabilities(id). The column
--      is renamed tool_id -> capability_id and its values are remapped by
--      capability IDENTIFIER (not by id — see note below).
--   2. Drop role_tools, then tools (role_tools FKs tools; tools self-FKs via
--      prompt_chain_tool_id). CASCADE handles the remaining legacy FK metadata.
--
-- NOTE on navigation_items remap: migration 079 backfilled capabilities
-- preserving the legacy tools ids, but the two tables have INDEPENDENT identity
-- sequences. Any tools row inserted AFTER 079 (e.g. an Assistant Architect
-- approved during the migration window) got a tools.id from the tools sequence
-- and a DIFFERENT capabilities.id from the capabilities sequence. We therefore
-- remap navigation_items by joining tools -> capabilities on identifier, never
-- by assuming tool_id == capability_id.
--
-- ⚠️ ORPHAN PRE-CHECK (run BEFORE deploying this migration):
--   A nav item whose tool_id has NO matching capabilities.identifier gets
--   capability_id = NULL and the navigation route treats NULL as "not gated" —
--   i.e. it becomes visible to EVERY user. This matches the prior
--   ON DELETE SET NULL behavior, but for a destructive migration it is worth
--   confirming there are zero such orphans so nothing is silently un-gated:
--
--     SELECT ni.id, ni.label, ni.tool_id
--     FROM navigation_items ni
--     LEFT JOIN tools t        ON ni.tool_id = t.id
--     LEFT JOIN capabilities c ON c.identifier = t.identifier
--     WHERE ni.tool_id IS NOT NULL AND c.id IS NULL;
--
--   If rows are returned, add the missing capabilities or delete the nav items
--   before deploying. Zero rows = safe.
--
-- NO PL/pgSQL / DO $$ blocks. The RDS Data API migration runner's statement
-- splitter cannot handle dollar-quoted blocks. Plain DDL/DML only.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '084-drop-legacy-tools-tables.sql' AND status = 'failed';

-- ---------------------------------------------------------------------------
-- 1. Re-point navigation_items.tool_id (FK -> tools) to capability_id (-> capabilities)
-- ---------------------------------------------------------------------------

-- 1a. Add the new nullable column (no FK yet, so we can backfill first).
ALTER TABLE navigation_items ADD COLUMN IF NOT EXISTS capability_id INTEGER;

-- 1b. Backfill capability_id from the legacy tool_id, matching by identifier.
-- Only rows whose tool maps to an existing capability are set; orphans stay NULL
-- (matching the prior ON DELETE SET NULL semantics — a missing capability simply
-- means the nav item is no longer capability-gated).
UPDATE navigation_items ni
SET capability_id = c.id
FROM tools t
JOIN capabilities c ON c.identifier = t.identifier
WHERE ni.tool_id = t.id
  AND ni.capability_id IS NULL;

-- 1c. Drop the old FK constraint and column (idempotent).
ALTER TABLE navigation_items DROP CONSTRAINT IF EXISTS navigation_items_tool_id_fkey;
ALTER TABLE navigation_items DROP COLUMN IF EXISTS tool_id;

-- 1d. Add the FK to capabilities. ON DELETE SET NULL mirrors the legacy
-- navigation_items_tool_id_fkey behavior so deleting a capability (e.g. on
-- Assistant Architect delete) nulls the reference instead of blocking the delete.
ALTER TABLE navigation_items
    ADD CONSTRAINT navigation_items_capability_id_fkey
    FOREIGN KEY (capability_id) REFERENCES capabilities(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Drop the legacy tables
-- ---------------------------------------------------------------------------

-- role_tools first (it FKs tools). CASCADE drops its own dependent metadata.
DROP TABLE IF EXISTS role_tools CASCADE;

-- tools last. CASCADE drops the self-referential prompt_chain_tool_id FK and any
-- remaining dependent constraints.
DROP TABLE IF EXISTS tools CASCADE;
