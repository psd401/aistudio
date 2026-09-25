-- ============================================================================
-- 185 — Live pages follow the latest save: one-time backfill
-- ============================================================================
--
-- Until now `content_publications.published_version_id` stayed pinned to
-- whatever version was live at the last explicit Publish/Republish. Saving a
-- new version only moved `content_objects.current_version_id`, so `/c/{slug}`
-- kept serving a weeks-old version while the editor showed the current one
-- (e.g. a building budget report still showing last fiscal year).
--
-- The application now advances the Live pin on every save
-- (`advanceLivePublications` in lib/content/live-publication.ts). This
-- migration applies the SAME rule once to every publication that is already
-- behind, so existing Live pages catch up without each author republishing.
--
-- The WHERE clause mirrors the application helper exactly:
--   * only LIVE rows (`status = 'live'`) at a live-surface destination
--     (`intranet`, or a pre-#1726 `public_web` row still serving readers);
--   * never in a `requires_approval` collection — those keep their review gate;
--   * only when the head's data-bridge mode equals the Live version's
--     (#1789/#1790): a head authored for a different mode is left for the
--     author to republish through the Share dialog's disclosure.
--
-- Idempotent: a re-run matches no rows (every eligible pin already equals its
-- object's head).
-- ============================================================================

UPDATE content_publications p
   SET published_version_id = o.current_version_id,
       updated_at = now()
  FROM content_objects o
  LEFT JOIN content_collections c ON c.id = o.collection_id
 WHERE p.object_id = o.id
   AND p.status = 'live'
   AND p.destination IN ('intranet', 'public_web')
   AND o.current_version_id IS NOT NULL
   AND p.published_version_id <> o.current_version_id
   AND COALESCE(c.requires_approval, false) = false
   AND (SELECT lv.data_access FROM content_versions lv
         WHERE lv.id = p.published_version_id)
       IS NOT DISTINCT FROM
       (SELECT nv.data_access FROM content_versions nv
         WHERE nv.id = o.current_version_id);
