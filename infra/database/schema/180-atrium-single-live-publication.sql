-- Migration 180: fold `public_web` publications into the single live row (#1726)
--
-- Atrium used to model publication as a DESTINATION choice — "the intranet" vs
-- "the public web" — which put it in direct competition with the object's
-- visibility Level. Reconciling the two needed a "Widen who can see this?"
-- prompt that was false (`/c/[slug]` runs `canView` before it looks at the
-- publication, so a group-scoped published object opens fine for its grantees),
-- UI-only (the same dialog could narrow the Level one save later), and
-- destructive (confirming it replaced the author's grants with none).
--
-- Publication is now ONE Live/Draft state, recorded as one `content_publications`
-- row at `destination = 'intranet'`. The Level alone decides the audience, and
-- the public address is DERIVED: `/p/{slug}` resolves when an object is Live AND
-- its Level is `public`.
--
-- This migration makes existing data match that model:
--   1. Every object with a live `public_web` row gets a live `intranet` row (its
--      published version carried over when it had no intranet row of its own).
--   2. Those `public_web` rows are then marked `unpublished`, so exactly one live
--      row remains per object.
--
-- An object that was live on BOTH becomes one live row (its intranet row, whose
-- published version is kept — the same version `/c/{slug}` was already serving).
-- An object live ONLY on `public_web` becomes Live + Public, which it already had
-- to be to pass the `/p/[slug]` gate.
--
-- DEPLOY ORDER — run this AFTER the new image is fully rolled out.
--
-- The NEW image is order-insensitive: `/p/[slug]` and `/c/[slug]` both accept a
-- live row at EITHER destination (`LIVE_SURFACE_DESTINATIONS`), so a page keeps
-- serving whether it has been folded yet or not.
--
-- The OLD image is NOT. Its `/p/[slug]` requires a live `public_web` row
-- specifically, and step 2 retires those. During a ROLLING ECS deploy the old
-- tasks keep taking traffic until they drain, so running this migration before
-- or alongside task replacement 404s the anonymous page of any object that was
-- live only through `public_web`, for as long as an old task is still serving.
-- (Its internal `/c/{slug}` page is unaffected either way: the old reader looks
-- for a live `intranet` row, and step 1 gives every such object one BEFORE step
-- 2 retires anything.)
--
-- The same asymmetry makes an image ROLLBACK after this has run 404 those public
-- pages. Fix forward. To undo deliberately, re-flip the retired rows:
--   UPDATE content_publications SET status = 'live'
--   WHERE destination = 'public_web' AND status = 'unpublished'
--     AND object_id IN (SELECT object_id FROM content_publications
--                       WHERE destination = 'intranet' AND status = 'live');
--
-- The `destination` column and the `publish_destination` enum are unchanged:
-- connector destinations (`schoology`, `google`, `okf`) genuinely are
-- destinations — "push a copy into another system" — and keep using them.
--
-- Idempotent: re-running finds no live `public_web` rows and does nothing.
--
-- No BEGIN/COMMIT: the db-init Lambda splits a migration into statements and runs
-- each through the RDS Data API, where every statement is its own transaction, so
-- an explicit block would be executed as two bare statements and fail. Each step
-- below is individually idempotent, and the only intermediate state (both rows
-- live) is the state this migration starts from — nothing is unreachable at any
-- point if it stops between steps.

-- 1a. Objects live on `public_web` whose `intranet` row exists but is NOT live
--     (`unpublished`, or `failed` — a publish whose transaction committed and
--     whose post-commit adapter then threw, leaving the row flagged `failed`).
--
--     Such a row's `published_version_id` names a version that was NEVER live:
--     `/c/{slug}` gates on `status = 'live'`, so readers were being served the
--     `public_web` row's version instead. Flipping the status while keeping the
--     stale version would silently substitute unreviewed content onto a page
--     that is about to go live — so the version, publisher and timestamp are
--     carried over from the row that was actually serving readers.
--
--     An `intranet` row that is ALREADY live is untouched by this statement (it
--     is excluded below) — its version is the one `/c/{slug}` was serving, and
--     an object live on both keeps it.
UPDATE content_publications AS ip
SET status = 'live',
    published_version_id = pw.published_version_id,
    published_by = pw.published_by,
    published_at = pw.published_at,
    -- The intranet adapter addresses the object by slug and records a NULL
    -- external_ref by design; carrying the /p/ URL across would be wrong.
    external_ref = NULL,
    updated_at = NOW()
FROM content_publications AS pw
WHERE ip.object_id = pw.object_id
  AND ip.destination = 'intranet'
  AND pw.destination = 'public_web'
  AND pw.status = 'live'
  AND ip.status IS DISTINCT FROM 'live';

-- 1b. Objects live on `public_web` with NO `intranet` row at all: create one,
--     carrying over the version and publisher the public page was serving.
INSERT INTO content_publications (
  object_id,
  destination,
  published_version_id,
  status,
  published_by,
  published_at,
  external_ref
)
SELECT
  pw.object_id,
  'intranet',
  pw.published_version_id,
  'live',
  pw.published_by,
  pw.published_at,
  -- The intranet adapter addresses the object by slug and deliberately records a
  -- NULL external_ref; carrying the /p/ URL across would be wrong for this row.
  NULL
FROM content_publications AS pw
WHERE pw.destination = 'public_web'
  AND pw.status = 'live'
  AND NOT EXISTS (
    SELECT 1
    FROM content_publications AS ip
    WHERE ip.object_id = pw.object_id
      AND ip.destination = 'intranet'
  )
ON CONFLICT (object_id, destination) DO NOTHING;

-- 2. Retire the `public_web` rows. Every object above now has its live intranet
--    row, and the public address is derived from Level + Live, so nothing that
--    was reachable stops being reachable.
UPDATE content_publications
SET status = 'unpublished',
    updated_at = NOW()
WHERE destination = 'public_web'
  AND status = 'live';
