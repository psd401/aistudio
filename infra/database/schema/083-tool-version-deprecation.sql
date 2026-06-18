-- Migration 083: Tool version deprecation lifecycle
-- Part of #927 (Epic #922, workstream #5 — Tool and skill versioning)
--
-- The tool_catalog table (migration 080) already carries `version`,
-- `deprecated_at`, and `replaced_by`. This migration adds the remaining two
-- deprecation-lifecycle columns so deprecation, the grace period, and the
-- computed removal date are first-class, queryable concepts:
--
--   1. grace_period_days — minimum days a deprecated version stays callable
--      before an admin may remove it. Snapshotted at deprecation time so a later
--      change to the global default never retroactively shortens an in-flight
--      grace window. Default 90 (the issue-confirmed minimum).
--   2. removal_date — computed `deprecated_at + grace_period_days` snapshot, set
--      when a version is deprecated. After this date an admin may hard-remove the
--      version. NULL while the version is not deprecated.
--
-- ADDITIVE and idempotent. No PL/pgSQL triggers / DO $$ blocks (the RDS Data API
-- migration runner's statement splitter cannot handle dollar-quoted blocks — see
-- migration 079). removal_date / grace_period_days are maintained by application
-- code (Drizzle) at deprecation time, not by a trigger.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '083-tool-version-deprecation.sql' AND status = 'failed';

-- 1. grace_period_days (default 90; never NULL so the resolver can always compute
--    a removal date from deprecated_at without a NULL guard).
ALTER TABLE tool_catalog
    ADD COLUMN IF NOT EXISTS grace_period_days INTEGER DEFAULT 90 NOT NULL;

-- 2. removal_date (NULL until a version is deprecated).
ALTER TABLE tool_catalog
    ADD COLUMN IF NOT EXISTS removal_date TIMESTAMP;

-- 3. Partial index over deprecated rows — the admin "version history" and the
--    deploy-time "past removal date" sweep both filter on deprecated_at IS NOT
--    NULL, so a partial index keeps those scans cheap as the catalog grows.
CREATE INDEX IF NOT EXISTS idx_tool_catalog_deprecated
    ON tool_catalog (deprecated_at)
    WHERE deprecated_at IS NOT NULL;

-- 4. Admin → Tool Versions navigation item (parent_id 11 = Admin, admin-only).
--    The version-history + deprecation UI lives at /admin/tools.
INSERT INTO navigation_items (label, icon, link, parent_id, requires_role, position, is_active, type, description)
SELECT 'Tool Versions', 'IconVersions', '/admin/tools', 11, 'administrator', 28, true, 'link',
       'Inspect tool catalog versions, deprecation state, and usage'
WHERE NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/admin/tools'
);
