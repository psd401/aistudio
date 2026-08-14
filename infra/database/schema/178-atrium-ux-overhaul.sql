-- ============================================================================
-- 178 — Atrium UX overhaul: collection hero art, shareable private
--       collections, and per-collection publish approval
--
-- Three independent, additive changes behind the Atrium admin/UX pass. Every
-- statement is idempotent and every new column is nullable or defaulted, so
-- existing collections keep working untouched.
--
--   1. Hero art on a section. Migration 175 gave collections a description;
--      they still had no visual identity, so every section landing page read
--      as the same wall of text. Raster art here (NOT the object-level
--      `cover_gradient` preset key, which is a fixed CSS gradient allowlist by
--      design) because sections carry real photography and generated header
--      images.
--
--   2. Shareable private collections. Migration 166 introduced owner-bound
--      private collections behind a CHECK that pinned them to
--      `private` + no inheritance. That made "organize my own work" possible
--      but "share the collection I built" impossible — the constraint rejected
--      the write before the service ever saw it. This widens the allowed
--      default to `private` OR `group` so an owner can grant access to their
--      own tree. `inherit_grants = false` still holds: a private tree never
--      silently absorbs district grants, and sharing stays an explicit,
--      per-collection act by its owner.
--
--   3. Per-collection publish approval. The district-wide policy is
--      unchanged and stays allow-then-notify (Hagel, 2026-07-25): authors
--      publish freely and non-admin public exposure records an admin-visible
--      audit row. This flag is a narrow, per-collection OPT-IN for the
--      collections where review is the point — the staff intranet and SOPs —
--      and it reuses the existing content_publish_requests queue rather than
--      introducing a second approval mechanism.
--
--      `approve` joins the collection-grant access levels so approver rosters
--      are configurable per collection instead of hardcoded to admins.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Section hero art
-- ---------------------------------------------------------------------------
-- The S3 object key, not a URL: presigned URLs expire and CDN hosts move, so
-- the durable identifier is the key and the read path resolves it through the
-- existing /api/images/[...key] route. Length 512 matches the key ceiling used
-- by the other S3-backed columns in this schema.
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS hero_image_key varchar(512);

-- Alt text is a separate column rather than packed into a JSONB blob because
-- it is required for accessibility on every rendered hero and is read on the
-- same query as the key.
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS hero_image_alt varchar(300);

-- ---------------------------------------------------------------------------
-- 2. Shareable private collections
-- ---------------------------------------------------------------------------
-- Widens migration 166's policy: an owner-bound collection may now default to
-- `group` (shared with explicit grantees) as well as `private`. It may still
-- never default to `internal` or `public` — a personal tree must not become
-- district-wide by default, which is the invariant 166 was protecting.
--
-- `inherit_grants = false` is retained deliberately: private trees never
-- inherit district grants down the hierarchy, so the only access to a shared
-- personal collection is the one its owner explicitly granted.
ALTER TABLE content_collections
  DROP CONSTRAINT IF EXISTS ck_collection_private_owner_policy;
ALTER TABLE content_collections
  ADD CONSTRAINT ck_collection_private_owner_policy
  CHECK (
    owner_user_id IS NULL
    OR (
      default_visibility_level IN ('private', 'group')
      AND inherit_grants = false
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Per-collection publish approval
-- ---------------------------------------------------------------------------
-- Default false: every existing collection keeps today's fluid publishing.
-- Only a collection explicitly switched on routes its publishes through the
-- approval queue.
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false;

-- Partial index — the gate check runs on every publish into a collection, but
-- the overwhelming majority of collections are ungated, so only index the rows
-- that can actually match.
CREATE INDEX IF NOT EXISTS idx_collection_requires_approval
  ON content_collections(id)
  WHERE requires_approval = true;

-- Add 'approve' to the collection-grant access levels so a collection can name
-- its own approver roster (by role, building, department, grade, user, or
-- Google group) instead of falling back to district admins. The service treats
-- the collection owner and district admins as implicit approvers on top of
-- whatever this table names.
ALTER TABLE content_collection_grants
  DROP CONSTRAINT IF EXISTS ck_content_collection_grant_access;
ALTER TABLE content_collection_grants
  ADD CONSTRAINT ck_content_collection_grant_access
  CHECK (access IN ('view', 'create', 'approve'));

-- ============================================================================
-- Manual rollback (not run automatically; only after application code has
-- stopped using the fields). Note the CHECK reversals will FAIL if any row
-- already violates the narrower constraint — narrow the data first:
--
--   DELETE FROM content_collection_grants WHERE access = 'approve';
--   ALTER TABLE content_collection_grants
--     DROP CONSTRAINT IF EXISTS ck_content_collection_grant_access;
--   ALTER TABLE content_collection_grants
--     ADD CONSTRAINT ck_content_collection_grant_access
--     CHECK (access IN ('view', 'create'));
--
--   UPDATE content_collections SET default_visibility_level = 'private'
--     WHERE owner_user_id IS NOT NULL AND default_visibility_level = 'group';
--   ALTER TABLE content_collections
--     DROP CONSTRAINT IF EXISTS ck_collection_private_owner_policy;
--   ALTER TABLE content_collections
--     ADD CONSTRAINT ck_collection_private_owner_policy
--     CHECK (
--       owner_user_id IS NULL
--       OR (default_visibility_level = 'private' AND inherit_grants = false)
--     );
--
--   DROP INDEX IF EXISTS idx_collection_requires_approval;
--   ALTER TABLE content_collections DROP COLUMN IF EXISTS requires_approval;
--   ALTER TABLE content_collections DROP COLUMN IF EXISTS hero_image_alt;
--   ALTER TABLE content_collections DROP COLUMN IF EXISTS hero_image_key;
-- ============================================================================
