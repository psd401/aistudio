-- ============================================================================
-- 159 — Atrium collection for Standard Operating Procedures
--
-- The psd-sop-creator agent skill files every SOP it drafts into a dedicated
-- Atrium collection so SOPs are findable as a set (`find --collection
-- standard-operating-procedures`) instead of being scattered across the
-- library. The skill passes the STABLE SLUG, so this row must exist before the
-- skill can create anything — an unresolvable collection is a hard 400 from
-- `resolveCollectionId` (lib/content/surface-helpers.ts), not a silent skip.
--
-- `default_visibility_level` is 'private' on purpose. SOPs are drafted by an
-- agent on a human's behalf and start as unreviewed drafts; a collection whose
-- default widened them to 'internal' would publish unreviewed operational
-- guidance district-wide the moment the skill omitted an explicit visibility.
-- The skill also passes `--visibility private` explicitly, so this is
-- defense in depth, not the only guard.
--
-- Idempotent (NOT EXISTS on the unique slug), matching the seeding style of
-- 085-atrium-content.sql §10a, so a re-run of the migration list is a no-op.
-- `nav_item_id` stays NULL like every other seeded collection; navigation
-- wiring is a separate concern.
-- ============================================================================

INSERT INTO content_collections (name, slug, default_visibility_level, position)
SELECT
  'Standard Operating Procedures',
  'standard-operating-procedures',
  'private',
  5
WHERE NOT EXISTS (
  SELECT 1 FROM content_collections WHERE slug = 'standard-operating-procedures'
);
