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
--   3. Objects the DEPLOY (not this migration) newly exposed to anonymous
--      visitors get a `publicExposure` audit row, so the widening is visible to
--      administrators. Runs before step 2, while a live `public_web` row still
--      distinguishes "was already public" from "just became public".
--
-- An object that was live on BOTH becomes one live row (its intranet row, whose
-- published version is kept — the same version `/c/{slug}` was already serving).
-- An object live ONLY on `public_web` becomes Live + Public, which it already had
-- to be to pass the `/p/[slug]` gate.
--
-- THE DEPLOY ALSO WIDENS IN THE OTHER DIRECTION, and step 3 records it.
--
-- Folding rows forward is only half the data story. The old `/p/[slug]` gate was
-- `visibility_level = 'public'` AND a live `public_web` row; the new one is
-- `public` AND live at EITHER destination. That is strictly wider, and it widens
-- at IMAGE DEPLOY, before this migration runs. Under the old UI the Level picker
-- and the publish destination were independent switches — that is what #1336
-- documented — so "Level = Public, published to the intranet only" was an
-- ordinary state, and publishing to the intranet needed only `internal`, so
-- nothing ever prompted about it. Every such object 404'd at `/p/{slug}` before
-- and is served anonymously after, and `app/sitemap.ts` applies the same
-- predicate on a route whose robots directive is index/follow, so crawlers are
-- handed the URLs too.
--
-- Nothing here narrows them: the author DID choose Public, and un-Living them
-- would break the internal reader they are legitimately serving. What was
-- missing was that the change was SILENT. Step 3 files the same
-- `publicExposure` audit row the in-app allow-then-notify policy files, so the
-- set shows up in the /admin/atrium Audit tab instead of nowhere.
--
-- To see the list BEFORE deploying (this is exactly step 3's SELECT):
--   SELECT o.id, o.slug, o.title FROM content_objects o
--   WHERE o.visibility_level = 'public'
--     AND EXISTS (SELECT 1 FROM content_publications p WHERE p.object_id = o.id
--                 AND p.destination = 'intranet' AND p.status = 'live')
--     AND NOT EXISTS (SELECT 1 FROM content_publications p WHERE p.object_id = o.id
--                     AND p.destination = 'public_web' AND p.status = 'live');
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

-- 3. Record the objects the DEPLOY made anonymously readable (see the header).
--
--    MUST run before step 2: the "was it already reachable at /p/?" test is the
--    presence of a live `public_web` row, and step 2 retires exactly those.
--
--    Attributed to the object's owner — the person who chose Public — with the
--    same `publicExposure` flag and `ui` surface the in-app notification uses, so
--    these rows land in the filter administrators already read rather than in a
--    channel nobody is watching. `content_audit_logs` is append-only and its
--    `object_id` carries no FK, so this cannot fail on a concurrent delete.
--
--    Idempotent: an object that already carries a live-switch `publicExposure`
--    row has had its exposure reported once, which is the point — re-running adds
--    nothing.
INSERT INTO content_audit_logs (
  object_id,
  action,
  surface,
  actor_kind,
  actor_user_id,
  destination,
  outcome,
  details
)
SELECT
  o.id,
  'publish',
  'ui',
  -- `actor_kind` is NOT NULL and has no "system" member; an agent-owned object
  -- has no owner_user_id to attribute, so it is recorded as the agent write it
  -- originally was.
  (CASE WHEN o.owner_user_id IS NOT NULL THEN 'human' ELSE 'agent' END)::actor_kind,
  o.owner_user_id,
  'intranet'::publish_destination,
  'ok',
  jsonb_build_object(
    'publicExposure', true,
    'note',
    'Already Public and live on the intranet, so it became readable without signing in when the public address became derived (#1726).'
  )
FROM content_objects AS o
WHERE o.visibility_level = 'public'
  AND EXISTS (
    SELECT 1 FROM content_publications AS p
    WHERE p.object_id = o.id AND p.destination = 'intranet' AND p.status = 'live'
  )
  AND NOT EXISTS (
    SELECT 1 FROM content_publications AS p
    WHERE p.object_id = o.id AND p.destination = 'public_web' AND p.status = 'live'
  )
  AND NOT EXISTS (
    SELECT 1 FROM content_audit_logs AS a
    WHERE a.object_id = o.id
      AND a.destination = 'intranet'
      AND a.details ->> 'publicExposure' = 'true'
  );

-- 2. Retire the `public_web` rows. Every object above now has its live intranet
--    row, and the public address is derived from Level + Live, so nothing that
--    was reachable stops being reachable.
UPDATE content_publications
SET status = 'unpublished',
    updated_at = NOW()
WHERE destination = 'public_web'
  AND status = 'live';
