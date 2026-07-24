-- ============================================================================
-- 132: Decommission scheduled assistant executions, results, and notifications
-- ============================================================================
-- The OpenClaw agent platform now owns scheduled work end-to-end (psd-schedules
-- skill -> DynamoDB + EventBridge Scheduler `psd-agent-{env}` group). The legacy
-- AI Studio scheduling feature (schedule an Assistant Architect run -> EventBridge
-- -> Lambda -> internal API -> email + in-app notification) is superseded and is
-- removed here (#1322). All application code, routes, components, infra stacks,
-- and Lambdas for this feature are deleted in the same PR.
--
-- Forward-only: migrations 035/041/047/048/091 that created/altered these tables
-- remain as historical files (immutable convention). Migration 067 alters
-- `agent_scheduled_runs` (agent platform) despite its name and is untouched.
--
-- No DO $$ blocks -- the local db-init statement splitter cannot parse them.

-- 1) Drop the three tables in FK order (children first). Each has a NOT NULL FK
--    to its parent with no ON DELETE CASCADE, so the order matters:
--    user_notifications -> execution_results -> scheduled_executions.
DROP TABLE IF EXISTS user_notifications;
DROP TABLE IF EXISTS execution_results;
DROP TABLE IF EXISTS scheduled_executions;

-- 2) Remove the "Assistant Scheduler" navigation entry (link '/schedules').
--    Prod navigation is DB-managed via /admin/navigation, so the cleanup must
--    live in the migration, not just the local seed. navigation_item_roles has
--    no FK, so clear its rows explicitly first.
DELETE FROM navigation_item_roles
WHERE navigation_item_id IN (
  SELECT id FROM navigation_items WHERE link = '/schedules'
);

DELETE FROM navigation_items WHERE link = '/schedules';

-- 3) Copy edit the assistant-architect capability description (scheduling is gone).
--    The boot-time manifest sync also reconciles this from
--    lib/capabilities/manifest.ts, but update here so the DB is correct before
--    the first server boot.
UPDATE capabilities
SET description = 'Build custom multi-step AI assistants.'
WHERE identifier = 'assistant-architect'
  AND description = 'Build and schedule custom multi-step AI assistants.';
