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
-- ADDITIVE and idempotent. No DO $$ blocks / inline PL/pgSQL function bodies
-- (the migration runner's statement splitter cannot handle dollar-quoted blocks
-- — see migration 079). `updated_at` columns ARE backed by PostgreSQL triggers
-- (section 11) that reference the pre-existing `update_updated_at_column()`
-- function from migration 017 — a single-statement `CREATE TRIGGER` needs no
-- dollar-quoting, so the splitter handles it (proven by migration 028). App
-- code still sets `updatedAt` explicitly via Drizzle as the fast path; the
-- trigger is the DB-level backstop for any write that bypasses it.
--
-- Ordering notes:
--   * CREATE TYPE statements are each on a single line so the runner's splitter
--     closes the enum block immediately (it treats a CREATE TYPE line as a block
--     that ends only at a line ending with ");").
--   * The `navigation_type` enum is intentionally NOT extended with a 'content'
--     value: `ALTER TYPE ... ADD VALUE` requires ownership of the type, but
--     navigation_type is owned by `postgres` (created in 001-enums.sql) while
--     migrations run as `master`. On Aurora that fails with "must be owner of
--     type navigation_type" (SQLSTATE 42501). Content nav items are identified by
--     the content_object_id column (§9), not a dedicated enum value — deferred to
--     Phase 4 (when nav wiring lands and the enum ownership can be addressed).
--   * content_collections is created before content_objects (objects FK to it).
--   * content_objects.current_version_id -> content_versions.id is a DEFERRED FK,
--     added after content_versions exists.
--   * created_by_agent_id / author_agent_id -> agent_identities.id FKs are added
--     after agent_identities exists.

-- NOTE: this migration does NOT pre-mark prior failed runs as completed. Doing
-- so before the DDL is unsafe: if a later statement in this file fails, the
-- "completed" row would already be written and `checkMigrationRun` (which skips
-- any file with a completed row) would permanently skip the migration, leaving
-- the partial schema unrepaired. Instead, every statement below is idempotent
-- (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / enum "already exists" handling),
-- so the runner can safely re-enter and re-apply this file after a failed run.

-- ============================================================================
-- 1. Enums (each CREATE TYPE on one line; idempotent via the runner's
--    CREATE TYPE "already exists" (SQLSTATE 42710) handling in
--    db-init-handler.ts, which no-ops these on a re-run).
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

-- (No navigation_type enum extension here — see the header note. Adding a
--  'content' value needs ownership of the postgres-owned enum, which the migration
--  role lacks on Aurora (SQLSTATE 42501). Content nav items use the
--  content_object_id column added in §9 instead. Deferred to Phase 4.)

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
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
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
-- Backs the listVisible ORDER BY updated_at DESC: without it Postgres falls back
-- to a full-scan sort (worsened by the correlated EXISTS visibility predicate) as
-- the table grows.
CREATE INDEX IF NOT EXISTS idx_content_objects_updated ON content_objects(updated_at DESC);
-- GIN index backing the listVisible tag filter (`<tag> = ANY(tags)`).
CREATE INDEX IF NOT EXISTS idx_content_tags        ON content_objects USING gin(tags);

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
-- DEFERRABLE INITIALLY DEFERRED so a writer may set current_version_id in the
-- same transaction that inserts the referenced content_versions row (the head
-- can be advanced before the row is visible at statement time); enforcement
-- runs at COMMIT. Matches the "DEFERRED FK" intent documented in the header.
ALTER TABLE content_objects DROP CONSTRAINT IF EXISTS fk_current_version;
ALTER TABLE content_objects
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id) REFERENCES content_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

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
-- The service path applies grants via delete-then-insert in a transaction, so the
-- normal path cannot duplicate. This DB-level guard blocks duplicates from future
-- code paths or direct SQL writes. Idempotent via DROP CONSTRAINT IF EXISTS.
ALTER TABLE content_visibility_grants DROP CONSTRAINT IF EXISTS uq_cvg;
ALTER TABLE content_visibility_grants
  ADD CONSTRAINT uq_cvg UNIQUE (object_id, grant_kind, grant_value);

-- ============================================================================
-- 6. content_publications (where a version is live)
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  destination publish_destination NOT NULL,
  -- RESTRICT (the default) is intentional: a version that is live at a
  -- destination must not be deletable out from under its publication record.
  published_version_id uuid NOT NULL REFERENCES content_versions(id),
  external_ref text,
  status publication_status NOT NULL DEFAULT 'live',
  published_by integer REFERENCES users(id),
  published_at timestamp NOT NULL DEFAULT now(),
  -- Status transitions (live -> unpublished -> failed, Phase 5/7) need an audit
  -- timestamp; published_at records first-publish only. Backed by the trigger
  -- in section 11 (DB-level backstop; app sets updatedAt via Drizzle too).
  updated_at timestamp NOT NULL DEFAULT now(),
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
  -- ON DELETE SET NULL: if the indexed version is removed, the link survives but
  -- is flagged stale (null) so the indexer (Phase 6) knows to re-index.
  indexed_version_id uuid REFERENCES content_versions(id) ON DELETE SET NULL,
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
-- 10. Seed data (idempotent; §10). Root collections + conservative autonomous
--     agent identities. None seed with content:publish_public.
--
--     NOTE (Phase 0): navigation_items are intentionally NOT seeded here. Phase 0
--     ships no browsable Atrium route, so a seeded `type='content'` nav item has
--     no valid destination: with link=NULL and no children it is silently
--     dropped by buildVisibleNavItems (app/api/navigation/route.ts) — an
--     invisible, confusing row — and pointing it at a not-yet-existing `/atrium`
--     route would render a 404. Nav seeding + the collection↔nav wiring move to
--     Phase 1, where they land together with the route. Only the
--     navigation_items.content_object_id column (§9 above) is added now; the
--     `content` navigation_type enum value is deferred to Phase 4 (ALTER TYPE
--     ADD VALUE needs ownership of the postgres-owned enum — see header note).
--     Content nav rows will set content_object_id rather than type='content'.
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

-- 10b/10c (navigation_items seeding + collection↔nav wiring): deferred to Phase 1.
--   See the section-10 note above. Phase 0 ships no Atrium route, so seeding nav
--   rows now produces either invisible (link=NULL, dropped by the nav filter) or
--   broken (404) entries. The collections above carry nav_item_id = NULL until
--   Phase 1 wires them to nav rows alongside the route.

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

-- ============================================================================
-- 11. updated_at triggers (CLAUDE.md: tables with updated_at MUST have the
--     PostgreSQL trigger so DB-level writes — bulk sweeps, future migrations —
--     never leave a stale timestamp. App-level `.set({ updatedAt })` is the
--     fast path; this is the DB-level backstop. `listVisible` sorts by
--     updated_at DESC, so stale timestamps would also corrupt list ordering.
--
--     These reference the pre-existing `update_updated_at_column()` function
--     (migration 017), so no PL/pgSQL / DO $$ block is needed here — the runner's
--     splitter handles a single `CREATE TRIGGER` statement (proven by migration
--     028). Idempotent via DROP TRIGGER IF EXISTS, mirroring 028.
-- ============================================================================
DROP TRIGGER IF EXISTS update_content_collections_updated_at ON content_collections;
CREATE TRIGGER update_content_collections_updated_at
  BEFORE UPDATE ON content_collections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_content_objects_updated_at ON content_objects;
CREATE TRIGGER update_content_objects_updated_at
  BEFORE UPDATE ON content_objects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_content_publications_updated_at ON content_publications;
CREATE TRIGGER update_content_publications_updated_at
  BEFORE UPDATE ON content_publications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_content_index_links_updated_at ON content_index_links;
CREATE TRIGGER update_content_index_links_updated_at
  BEFORE UPDATE ON content_index_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
