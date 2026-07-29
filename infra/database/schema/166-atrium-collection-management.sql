-- ============================================================================
-- 166 — Atrium collection management, ownership, grants, and lifecycle (#1438)
--
-- Additive/idempotent extension of migration 085's content_collections table.
-- Existing collections remain district/shared (owner_user_id IS NULL), active,
-- and grant-unrestricted, preserving their URLs and create behavior.
--
-- Private collections are identified by owner_user_id. The database backstop
-- forces them to default to private visibility and disables grant inheritance.
-- Collection grants are normalized and distinguish view from create access.
-- Zero grants preserves the legacy unrestricted-collection behavior.
-- ============================================================================

ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS owner_user_id integer REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS inherit_grants boolean NOT NULL DEFAULT true;
ALTER TABLE content_collections
  ADD COLUMN IF NOT EXISTS archived_at timestamp;

CREATE INDEX IF NOT EXISTS idx_collection_owner
  ON content_collections(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_collection_archived
  ON content_collections(archived_at);

ALTER TABLE content_collections
  DROP CONSTRAINT IF EXISTS ck_collection_private_owner_policy;
ALTER TABLE content_collections
  ADD CONSTRAINT ck_collection_private_owner_policy
  CHECK (
    owner_user_id IS NULL
    OR (default_visibility_level = 'private' AND inherit_grants = false)
  );

CREATE TABLE IF NOT EXISTS content_collection_grants (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES content_collections(id) ON DELETE CASCADE,
  access varchar(16) NOT NULL,
  grant_kind grant_kind NOT NULL,
  grant_value varchar(255) NOT NULL,
  CONSTRAINT ck_content_collection_grant_access
    CHECK (access IN ('view', 'create')),
  CONSTRAINT uq_content_collection_grant
    UNIQUE (collection_id, access, grant_kind, grant_value)
);

CREATE INDEX IF NOT EXISTS idx_ccg_collection
  ON content_collection_grants(collection_id);
CREATE INDEX IF NOT EXISTS idx_ccg_lookup
  ON content_collection_grants(access, grant_kind, grant_value);

-- The collection that originally motivated #1438. Stable slug, district/shared,
-- internal-by-default, and idempotent across fresh and upgraded installations.
WITH district_top_level AS MATERIALIZED (
  SELECT position
  FROM content_collections
  WHERE parent_id IS NULL AND owner_user_id IS NULL
),
next_position AS (
  SELECT
    CASE
      WHEN COALESCE(MAX(position), -1) < 2147483647
        THEN COALESCE(MAX(position), -1) + 1
      ELSE (
        -- int4 max is already occupied: mirror the service's bounded gap
        -- allocator instead of overflowing MAX(position) + 1.
        SELECT candidate
        FROM generate_series(
          0,
          (
            SELECT LEAST(COUNT(*), 2147483647)::integer
            FROM district_top_level
          )
        ) AS gap(candidate)
        WHERE NOT EXISTS (
          SELECT 1
          FROM district_top_level existing
          WHERE existing.position = gap.candidate
        )
        ORDER BY candidate
        LIMIT 1
      )
    END AS position
  FROM district_top_level
)
INSERT INTO content_collections (
  name,
  slug,
  default_visibility_level,
  owner_user_id,
  inherit_grants,
  position
)
SELECT
  'PSD Staff Intranet',
  'psd-staff-intranet',
  'internal',
  NULL,
  true,
  next_position.position
FROM next_position
WHERE NOT EXISTS (
  SELECT 1 FROM content_collections WHERE slug = 'psd-staff-intranet'
);

-- Manual rollback (only if application code has first stopped using the fields):
-- DROP TABLE IF EXISTS content_collection_grants;
-- ALTER TABLE content_collections DROP CONSTRAINT IF EXISTS ck_collection_private_owner_policy;
-- ALTER TABLE content_collections DROP COLUMN IF EXISTS archived_at;
-- ALTER TABLE content_collections DROP COLUMN IF EXISTS inherit_grants;
-- ALTER TABLE content_collections DROP COLUMN IF EXISTS owner_user_id;
