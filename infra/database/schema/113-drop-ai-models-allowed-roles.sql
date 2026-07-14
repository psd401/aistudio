-- Migration 113: drop ai_models.allowed_roles (Epic #1202, Phase 4 / #1207)
--
-- The legacy per-model role allow-list column (added in migration 024) is retired.
-- Its role semantics were migrated to the generic resource_access_grants table in
-- Phase 3 (migration 111 backfilled every allowed_roles entry into a ('model',
-- resource_id, 'role', role_name) grant row), and ALL read paths now resolve model
-- access exclusively through resource_access_grants:
--   * lib/db/drizzle/resource-access.ts (userCanAccessResource /
--     filterAccessibleResourceIds) — the authoritative execution gate,
--   * GET /api/models — server-side filters the model list before it reaches the
--     model-selector (the client role filter was removed in this release).
-- The nexus provider factory / cost optimizer selected allowed_roles into a typed
-- field but never USED it for any decision (verified in #1207); those dead selects
-- are removed in the same release. The write-time bridge (syncModelAllowedRoleGrants)
-- and the admin "Allowed Roles (legacy)" field are removed too — per-model
-- role/group access is edited solely via the ResourceGrantsEditor.
--
-- DEPLOY ORDERING. This migration ships in the SAME release as the code that stops
-- referencing the column. Follow the repo precedent (migrations 045/046/084 dropped
-- columns/tables the same way): during an ECS rolling deploy there is a brief window
-- where an old task might still SELECT allowed_roles; those queries are read-only and
-- their only caller (nexus model listing) already catches errors and returns [], so
-- the worst case is a momentarily-empty model list, never a crash or an access
-- escalation (execution stays gated by resource_access_grants throughout).
--
-- ADDITIVE-SAFE and idempotent: DROP ... IF EXISTS on both the GIN index (024) and
-- the column. A plain single-statement drop — no PL/pgSQL DO $$ block (the migration
-- runner's splitter only enters block mode on CREATE TYPE/FUNCTION/DROP TYPE), and no
-- CONCURRENTLY (rejected by the RDS Data API validator). DROP COLUMN also drops any
-- remaining dependent objects (the GIN index) automatically; dropping the index first
-- is explicit and keeps the intent auditable.

DROP INDEX IF EXISTS idx_ai_models_allowed_roles;

ALTER TABLE ai_models DROP COLUMN IF EXISTS allowed_roles;
