-- ============================================================================
-- 183 — Version-scoped artifact data-access mode (#1789)
-- ============================================================================
--
-- Migration 179 put `data_access` on `content_objects`, i.e. on the OBJECT.
-- The code the mode gates does not live on the object — it lives on a
-- `content_versions` row, and `/c/{slug}` renders the version a publication
-- pins, not the head. So the object-level column made the Live page's
-- capability follow the author's DRAFT:
--
--   * a Live records-mode sign-up sheet whose author flips to `query` while
--     building the next version breaks `AtriumData.submit` for every reader,
--     immediately, with no republish;
--   * the reverse takes a Live dashboard's data offline.
--
-- This migration stamps the mode on the version that was written under it.
--
-- Semantics after this migration:
--   * `content_versions.data_access` — the mode THIS version's code was
--     authored for. Every surface pins the mode of the version it RENDERS:
--     `/c/` pins the published version's, the editor pins the head's.
--   * `content_objects.data_access` — the mode of the working HEAD (and the
--     value stamped onto the next version). `contentService.update` keeps the
--     head's stamp equal to it; when the head IS the live published version it
--     writes a NEW version instead, so Live keeps the capability it was
--     published with.
--
-- NULLABLE by design:
--   * `document` versions have no sandbox, so their mode stays NULL rather
--     than carrying a meaningless `records`.
--   * A NULL on an artifact version means "written before this migration
--     reached this row"; every reader resolves it as
--     `version.data_access ?? object.data_access`, which is exactly the
--     pre-migration behaviour. Nothing changes capability at deploy time.
--
-- Migration-runner notes:
--   * `content_data_access` already exists (migration 179) — this file does
--     NOT re-create it.
--   * ADD COLUMN IF NOT EXISTS + an idempotent backfill make a re-run a no-op.
--   * The backfill is scoped to artifacts and to rows that are still NULL, so
--     re-running it can never overwrite a stamp written by application code
--     between two runs.
-- ============================================================================

ALTER TABLE content_versions
  ADD COLUMN IF NOT EXISTS data_access content_data_access;

-- Backfill: each EXISTING artifact version inherits its object's current mode.
-- That is the mode those versions have effectively been running under, so the
-- backfill is behaviour-preserving rather than a capability change.
UPDATE content_versions v
   SET data_access = o.data_access
  FROM content_objects o
 WHERE o.id = v.object_id
   AND o.kind = 'artifact'
   AND v.data_access IS NULL;
