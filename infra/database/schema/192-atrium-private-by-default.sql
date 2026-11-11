-- =====================================================
-- Migration: 192-atrium-private-by-default.sql
-- Description: Return all-staff Atrium content to private (#2034).
-- Dependencies: 085-atrium-content.sql, 090 (content_audit_logs)
--
-- Policy: Atrium content is private to its owner unless someone explicitly
-- widens it. Until #2034, agent skills created every HTML page at `internal`
-- (all staff) and published it, and content created in a collection inherited
-- the collection's default level. This sets `internal` objects back to
-- `private`, by decision of the district owner, and owners re-share
-- deliberately.
--
-- The audit trail CANNOT separate a deliberate all-staff share from a skill
-- default: an explicit create at `internal` is logged only as `create`, and a
-- Share-dialog change (setVisibilityAction) writes no audit row unless the
-- level is `public`. So this resets deliberate shares too. The only objects
-- kept `internal` are those widened through the REST/MCP set-visibility path
-- (a successful `set_visibility` audit row) and those owned by user id 1,
-- which the district owner excluded.
-- `internal` objects carry no grants, so there are none to clear.
--
-- Each change is recorded as a `set_visibility` audit row with surface
-- `migration` and details.previousLevel, so it is reversible and a re-run is a
-- no-op (the new audit rows exclude the objects on a second pass).
--
-- Rollback:
-- UPDATE content_objects SET visibility_level = 'internal'
-- WHERE id IN (
--   SELECT object_id FROM content_audit_logs
--   WHERE surface = 'migration'
--     AND details->>'migration' = '192-atrium-private-by-default'
-- );
-- DELETE FROM content_audit_logs
-- WHERE surface = 'migration'
--   AND details->>'migration' = '192-atrium-private-by-default';
-- =====================================================

WITH targets AS (
  SELECT o.id
  FROM content_objects o
  WHERE o.visibility_level = 'internal'
    AND o.owner_user_id IS DISTINCT FROM 1
    AND NOT EXISTS (
      SELECT 1
      FROM content_audit_logs l
      WHERE l.object_id = o.id
        AND l.action = 'set_visibility'
        AND l.outcome = 'ok'
    )
),
logged AS (
  INSERT INTO content_audit_logs (object_id, action, surface, actor_kind, outcome, details)
  SELECT
    t.id,
    'set_visibility',
    'migration',
    'human',
    'ok',
    jsonb_build_object(
      'migration', '192-atrium-private-by-default',
      'previousLevel', 'internal',
      'note', 'Private by default (#2034): never explicitly widened'
    )
  FROM targets t
  RETURNING object_id
)
UPDATE content_objects
SET visibility_level = 'private'
WHERE id IN (SELECT object_id FROM logged);
