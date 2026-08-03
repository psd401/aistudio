-- ============================================================================
-- 175 — Atrium library usability: per-user favorites + section landing copy
--
-- Two additive, independent changes behind the Atrium UX pass:
--
--   1. content_user_favorites — a per-user star on a content object. Nothing in
--      the schema recorded per-user interaction with content before this
--      (content_objects rows are shared, and content_audit_logs is mutation-only
--      with no read/view action), so a curated library home had no way to lead
--      with "the things this person cares about".
--
--   2. content_collections.description / landing_object_id — a section had a
--      name and nothing else, so opening one dropped the reader straight into an
--      unexplained list. The description is the section hero's body copy;
--      landing_object_id optionally pins one "start here" document.
--
-- Both are nullable/absent-tolerant: existing rows keep working untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-user favorites
-- ---------------------------------------------------------------------------
-- Composite PK, not a surrogate id: (user_id, object_id) IS the identity, and
-- it makes the "is this favorited" lookup and the ON CONFLICT DO NOTHING toggle
-- both index-only. ON DELETE CASCADE on both sides — a favorite is meaningless
-- once either the user or the object is gone, and it must never keep a deleted
-- object alive in someone's library.
CREATE TABLE IF NOT EXISTS content_user_favorites (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, object_id)
);

-- The PK covers (user_id, …) lookups. This index serves the reverse direction:
-- cascading deletes by object, and any "how many people favorited this" read.
CREATE INDEX IF NOT EXISTS idx_content_user_favorites_object
  ON content_user_favorites(object_id);

-- Orders a user's favorites list newest-first without a sort.
CREATE INDEX IF NOT EXISTS idx_content_user_favorites_user_created
  ON content_user_favorites(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Section landing copy
-- ---------------------------------------------------------------------------
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS description text;

-- The pinned "start here" object for this section's landing page. ON DELETE SET
-- NULL, not CASCADE: deleting the pinned document must unpin it, never delete
-- the section. No FK-level guarantee that the target lives IN this collection —
-- that is enforced in the service layer, where the visibility rules also live.
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS landing_object_id uuid
  REFERENCES content_objects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_collection_landing_object
  ON content_collections(landing_object_id);

-- ============================================================================
-- Manual rollback (not run automatically):
--
--   DROP INDEX IF EXISTS idx_collection_landing_object;
--   ALTER TABLE content_collections DROP COLUMN IF EXISTS landing_object_id;
--   ALTER TABLE content_collections DROP COLUMN IF EXISTS description;
--   DROP INDEX IF EXISTS idx_content_user_favorites_user_created;
--   DROP INDEX IF EXISTS idx_content_user_favorites_object;
--   DROP TABLE IF EXISTS content_user_favorites;
-- ============================================================================
