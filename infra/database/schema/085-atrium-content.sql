-- Migration 085: Atrium content workspace — data model spine
-- Part of #1058 (Epic #1059, Atrium Phase 0 — Content API + data model)
--
-- Builds the spine the entire Atrium content layer is a thin client of: the
-- content object model, immutable versions with human/agent provenance,
-- collections (intranet sections), normalized visibility grants, publication
-- records, autonomous agent identities, and the retrieval index link table.
-- Every surface (in-app editors, MCP, REST v1, scheduled skills) writes through
-- the lib/content/ service over these tables — there is no UI-only creation path.
--
-- See docs/features/atrium-design-spec.md §7-§10.
--
-- ADDITIVE and idempotent. No PL/pgSQL triggers / DO $$ blocks (the migration
-- runner's statement splitter cannot handle dollar-quoted blocks — see migration
-- 079). `updated_at` columns are maintained by application code via Drizzle
-- `.set({ updatedAt: new Date() })`, not by a trigger.
--
-- Ordering notes:
--   * CREATE TYPE statements are each on a single line so the runner's splitter
--     closes the enum block immediately (it treats a CREATE TYPE line as a block
--     that ends only at a line ending with ");").
--   * `ALTER TYPE navigation_type ADD VALUE` runs as its own auto-committed
--     statement (the runner executes statements individually, never inside a
--     BEGIN/COMMIT), which Postgres requires for enum-value additions.
--   * content_collections is created before content_objects (objects FK to it).
--   * content_objects.current_version_id -> content_versions.id is a DEFERRED FK,
--     added after content_versions exists.
--   * created_by_agent_id / author_agent_id -> agent_identities.id FKs are added
--     after agent_identities exists.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '085-atrium-content.sql' AND status = 'failed';

-- ============================================================================
-- 1. Enums (each CREATE TYPE on one line; idempotent via runner's "already
--    exists" handling — these are wrapped to no-op on re-run).
-- ============================================================================
CREATE TYPE content_kind AS ENUM ('document', 'artifact');
CREATE TYPE content_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE actor_kind AS ENUM ('human', 'agent');
CREATE TYPE visibility_level AS ENUM ('private', 'group', 'internal', 'public');
CREATE TYPE grant_kind AS ENUM ('role', 'building', 'department', 'grade', 'user');
CREATE TYPE body_format AS ENUM ('markdown', 'html', 'jsx');
CREATE TYPE publish_destination AS ENUM ('intranet', 'public_web', 'schoology', 'google');
CREATE TYPE publication_status AS ENUM ('live', 'scheduled', 'unpublished', 'failed');
CREATE TYPE agent_identity_kind AS ENUM ('service', 'skill');

-- Extend the existing navigation_type enum. Must be its own statement and cannot
-- run inside a transaction block (the runner auto-commits each statement).
ALTER TYPE navigation_type ADD VALUE IF NOT EXISTS 'content';

-- ============================================================================
-- 2. content_collections (created first; objects FK to it)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  slug varchar(200) NOT NULL UNIQUE,
  parent_id uuid,
  default_visibility_level visibility_level NOT NULL DEFAULT 'internal',
  nav_item_id integer REFERENCES navigation_items(id),
  position integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collection_parent ON content_collections(parent_id);

-- Self-referential parent FK (added separately so the table can reference itself).
ALTER TABLE content_collections DROP CONSTRAINT IF EXISTS fk_collection_parent;
ALTER TABLE content_collections
  ADD CONSTRAINT fk_collection_parent
  FOREIGN KEY (parent_id) REFERENCES content_collections(id);

-- ============================================================================
-- 3. content_objects (the spine)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind content_kind NOT NULL,
  title varchar(500) NOT NULL,
  slug varchar(200) NOT NULL UNIQUE,
  owner_user_id integer NOT NULL REFERENCES users(id),
  created_by_actor actor_kind NOT NULL,
  created_by_agent_id uuid,
  collection_id uuid REFERENCES content_collections(id),
  visibility_level visibility_level NOT NULL DEFAULT 'private',
  current_version_id uuid,
  source_ref jsonb,
  tags text[],
  status content_status NOT NULL DEFAULT 'draft',
  indexed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_owner       ON content_objects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_content_collection  ON content_objects(collection_id);
CREATE INDEX IF NOT EXISTS idx_content_status_kind ON content_objects(status, kind);
CREATE INDEX IF NOT EXISTS idx_content_visibility  ON content_objects(visibility_level);

-- ============================================================================
-- 4. content_versions (immutable history)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  author_actor actor_kind NOT NULL,
  author_user_id integer REFERENCES users(id),
  author_agent_id uuid,
  body_format body_format NOT NULL,
  body_location text NOT NULL,
  body_inline text,
  render_location text,
  proof_doc_ref varchar(255),
  summary text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_version_object_number UNIQUE (object_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_version_object ON content_versions(object_id);

-- Deferred FK: content_objects.current_version_id -> content_versions.id.
ALTER TABLE content_objects DROP CONSTRAINT IF EXISTS fk_current_version;
ALTER TABLE content_objects
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id) REFERENCES content_versions(id);

-- ============================================================================
-- 5. content_visibility_grants (normalized group access)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_visibility_grants (
  id serial PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  grant_kind grant_kind NOT NULL,
  grant_value varchar(255) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cvg_object ON content_visibility_grants(object_id);
CREATE INDEX IF NOT EXISTS idx_cvg_lookup ON content_visibility_grants(grant_kind, grant_value);

-- ============================================================================
-- 6. content_publications (where a version is live)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  destination publish_destination NOT NULL,
  published_version_id uuid NOT NULL REFERENCES content_versions(id),
  external_ref text,
  status publication_status NOT NULL DEFAULT 'live',
  published_by integer REFERENCES users(id),
  published_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_pub_object_destination UNIQUE (object_id, destination)
);

-- ============================================================================
-- 7. agent_identities (autonomous service/skill agents)
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  kind agent_identity_kind NOT NULL,
  role_id integer REFERENCES roles(id),
  scopes text[] NOT NULL,
  oauth_client_id varchar(255),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

-- Cross-table agent FKs (added after agent_identities exists).
ALTER TABLE content_objects DROP CONSTRAINT IF EXISTS fk_content_created_by_agent;
ALTER TABLE content_objects
  ADD CONSTRAINT fk_content_created_by_agent
  FOREIGN KEY (created_by_agent_id) REFERENCES agent_identities(id);

ALTER TABLE content_versions DROP CONSTRAINT IF EXISTS fk_version_author_agent;
ALTER TABLE content_versions
  ADD CONSTRAINT fk_version_author_agent
  FOREIGN KEY (author_agent_id) REFERENCES agent_identities(id);

-- ============================================================================
-- 8. content_index_links (object -> retrieval repository_item)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_index_links (
  id serial PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  repository_item_id integer NOT NULL REFERENCES repository_items(id) ON DELETE CASCADE,
  indexed_version_id uuid,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_index_object UNIQUE (object_id)
);

-- ============================================================================
-- 9. navigation_items extension: point a nav item at a content object
-- ============================================================================
ALTER TABLE navigation_items ADD COLUMN IF NOT EXISTS content_object_id uuid;
ALTER TABLE navigation_items DROP CONSTRAINT IF EXISTS fk_nav_content_object;
ALTER TABLE navigation_items
  ADD CONSTRAINT fk_nav_content_object
  FOREIGN KEY (content_object_id) REFERENCES content_objects(id);

-- ============================================================================
-- 10. Seed data (idempotent; §10). Root collections + a nav section per
--     collection + conservative autonomous agent identities. None seed with
--     content:publish_public.
-- ============================================================================

-- 10a. Root collections (slugs are stable; names editable).
INSERT INTO content_collections (name, slug, default_visibility_level, position)
SELECT 'District handbook', 'district-handbook', 'internal', 0
WHERE NOT EXISTS (SELECT 1 FROM content_collections WHERE slug = 'district-handbook');

INSERT INTO content_collections (name, slug, default_visibility_level, position)
SELECT 'High School', 'high-school', 'group', 1
WHERE NOT EXISTS (SELECT 1 FROM content_collections WHERE slug = 'high-school');

INSERT INTO content_collections (name, slug, default_visibility_level, position)
SELECT 'Special Education', 'special-education', 'group', 2
WHERE NOT EXISTS (SELECT 1 FROM content_collections WHERE slug = 'special-education');

INSERT INTO content_collections (name, slug, default_visibility_level, position)
SELECT 'Assessment & data', 'assessment-data', 'group', 3
WHERE NOT EXISTS (SELECT 1 FROM content_collections WHERE slug = 'assessment-data');

INSERT INTO content_collections (name, slug, default_visibility_level, position)
SELECT 'Public site', 'public-site', 'public', 4
WHERE NOT EXISTS (SELECT 1 FROM content_collections WHERE slug = 'public-site');

-- 10b. A nav section per collection (type='content'), linked via nav_item_id.
--      Created under no parent (top-level sections); link is wired back onto the
--      collection after insert. Idempotent on the nav label.
INSERT INTO navigation_items (label, icon, link, type, position, is_active, description)
SELECT 'District handbook', 'IconBook', NULL, 'content', 100, true, 'Atrium collection: District handbook'
WHERE NOT EXISTS (SELECT 1 FROM navigation_items WHERE label = 'District handbook' AND type = 'content');

INSERT INTO navigation_items (label, icon, link, type, position, is_active, description)
SELECT 'High School', 'IconSchool', NULL, 'content', 101, true, 'Atrium collection: High School'
WHERE NOT EXISTS (SELECT 1 FROM navigation_items WHERE label = 'High School' AND type = 'content');

INSERT INTO navigation_items (label, icon, link, type, position, is_active, description)
SELECT 'Special Education', 'IconAccessible', NULL, 'content', 102, true, 'Atrium collection: Special Education'
WHERE NOT EXISTS (SELECT 1 FROM navigation_items WHERE label = 'Special Education' AND type = 'content');

INSERT INTO navigation_items (label, icon, link, type, position, is_active, description)
SELECT 'Assessment & data', 'IconChartBar', NULL, 'content', 103, true, 'Atrium collection: Assessment & data'
WHERE NOT EXISTS (SELECT 1 FROM navigation_items WHERE label = 'Assessment & data' AND type = 'content');

INSERT INTO navigation_items (label, icon, link, type, position, is_active, description)
SELECT 'Public site', 'IconWorld', NULL, 'content', 104, true, 'Atrium collection: Public site'
WHERE NOT EXISTS (SELECT 1 FROM navigation_items WHERE label = 'Public site' AND type = 'content');

-- 10c. Wire each collection to its nav item (only where not already linked).
UPDATE content_collections c
SET nav_item_id = n.id
FROM navigation_items n
WHERE n.type = 'content' AND n.label = 'District handbook' AND c.slug = 'district-handbook' AND c.nav_item_id IS NULL;

UPDATE content_collections c
SET nav_item_id = n.id
FROM navigation_items n
WHERE n.type = 'content' AND n.label = 'High School' AND c.slug = 'high-school' AND c.nav_item_id IS NULL;

UPDATE content_collections c
SET nav_item_id = n.id
FROM navigation_items n
WHERE n.type = 'content' AND n.label = 'Special Education' AND c.slug = 'special-education' AND c.nav_item_id IS NULL;

UPDATE content_collections c
SET nav_item_id = n.id
FROM navigation_items n
WHERE n.type = 'content' AND n.label = 'Assessment & data' AND c.slug = 'assessment-data' AND c.nav_item_id IS NULL;

UPDATE content_collections c
SET nav_item_id = n.id
FROM navigation_items n
WHERE n.type = 'content' AND n.label = 'Public site' AND c.slug = 'public-site' AND c.nav_item_id IS NULL;

-- 10d. Autonomous agent identities with conservative scopes. None hold
--      content:publish_public. role_id defaults to the 'staff' role so their
--      content reads at staff-level visibility; the subquery is NULL-safe.
INSERT INTO agent_identities (name, kind, role_id, scopes, is_active)
SELECT 'ship-reporter', 'service', (SELECT id FROM roles WHERE name = 'staff' LIMIT 1),
       ARRAY['content:create', 'content:publish_internal'], true
WHERE NOT EXISTS (SELECT 1 FROM agent_identities WHERE name = 'ship-reporter');

INSERT INTO agent_identities (name, kind, role_id, scopes, is_active)
SELECT 'screentime-bot', 'service', (SELECT id FROM roles WHERE name = 'staff' LIMIT 1),
       ARRAY['content:create', 'content:publish_internal'], true
WHERE NOT EXISTS (SELECT 1 FROM agent_identities WHERE name = 'screentime-bot');

INSERT INTO agent_identities (name, kind, role_id, scopes, is_active)
SELECT 'tutorial-publisher', 'skill', (SELECT id FROM roles WHERE name = 'staff' LIMIT 1),
       ARRAY['content:create', 'content:update'], true
WHERE NOT EXISTS (SELECT 1 FROM agent_identities WHERE name = 'tutorial-publisher');
