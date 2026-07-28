-- Migration 156: Admit OneRoster-managed application role grants (Epic #1308 / #1312)
--
-- The existing user_roles.source constraint owns source isolation for manual
-- assignments and Google group reconciliation. OneRoster reconciliation gets
-- its own source so it can revoke only the rows it previously granted.

ALTER TABLE user_roles
  DROP CONSTRAINT IF EXISTS user_roles_source_check;

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_source_check
  CHECK (source IN ('manual', 'group-sync', 'oneroster'));

COMMENT ON COLUMN user_roles.source IS
  'Grant owner: manual, group-sync, or oneroster. Reconcilers may mutate only their own source.';

-- ============================================================
-- ROLLBACK SQL (manual; disable ROSTER_ROLE_SYNC_ENABLED first)
-- ============================================================
-- WITH deleted AS (
--   DELETE FROM user_roles
--    WHERE source = 'oneroster'
--   RETURNING user_id
-- )
-- UPDATE users
--    SET role_version = coalesce(role_version, 0) + 1,
--        updated_at = now()
--  WHERE id IN (SELECT DISTINCT user_id FROM deleted);
-- ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_source_check;
-- ALTER TABLE user_roles
--   ADD CONSTRAINT user_roles_source_check
--   CHECK (source IN ('manual', 'group-sync'));
-- COMMENT ON COLUMN user_roles.source IS
--   'Grant owner: manual or group-sync. Reconcilers may mutate only their own source.';
