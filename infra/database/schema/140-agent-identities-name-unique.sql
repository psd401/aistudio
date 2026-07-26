-- ============================================================================
-- 140: de-duplicate agent_identities by name + make `name` a unique key (#1303)
-- ============================================================================
--
-- WHY. `agent_identities.name` is the logical key every seeding path keys on,
-- but the table only ever had a surrogate `id uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()` and NO uniqueness on `name`. Three independent paths write
-- these rows:
--
--   1. migration 085 (§10d) — INSERT ... SELECT ... WHERE NOT EXISTS (name = ?)
--      for `ship-reporter`, `screentime-bot`, `tutorial-publisher`. It does NOT
--      pin an id, so every FRESH environment mints different random uuids and
--      stamps created_at = now() at deploy time.
--   2. migration 095 (§2) — `atrium-importer`, guarded on a FIXED id
--      ('0a710f00-0000-4000-a000-000000000f36'), not on name.
--   3. scripts/seed-atrium-agents.ts — looks the identity up by name and
--      updates in place, but its INSERT had no ON CONFLICT clause.
--
-- Each guard is a read-then-write (TOCTOU) check against a column with no
-- constraint behind it, and guards 1 and 2 key on DIFFERENT columns. On the
-- fresh prod stand-up (2026-07-24) migration 085 seeded three rows with fresh
-- random uuids at deploy time, and the dev->prod data copy then inserted dev's
-- rows for the SAME three names — its ON CONFLICT was on `id`, which could not
-- fire because the uuids differed. Result: `ship-reporter`, `screentime-bot`
-- and `tutorial-publisher` each existed twice. `atrium-importer` survived
-- single-rowed only because its deterministic id made the copy's id-conflict
-- actually fire.
--
-- Duplicate actor rows split attribution: six columns FK to agent_identities
-- (content_objects.created_by_agent_id, content_versions.author_agent_id,
-- content_audit_logs.agent_id, content_publish_requests.requested_by_agent_id,
-- atrium_doc_comments.author_agent_id, content_assets.uploader_agent_id), and
-- which duplicate a given code path resolves depends on which one its lookup
-- happened to return. (`scheduled_executions.agent_identity_id`, listed on
-- #1303, no longer exists — migration 133 dropped that table.)
--
-- WHAT THIS DOES.
--   1. Repoints every FK reference away from duplicate rows onto one canonical
--      row per name.
--   2. Deletes the now-unreferenced duplicates.
--   3. Adds a UNIQUE index on `name`, so no future seeding path — migration,
--      script, data copy, or application code — can create a second row for a
--      name regardless of what id it picks. This replaces three racy
--      read-then-write guards with one database-enforced invariant.
--
-- CANONICAL-ROW CHOICE (ORDER BY inside the DISTINCT ON), most significant first:
--   a. `(id <> '0a710f00-0000-4000-a000-000000000f36')` ascending -> the row
--      whose id APPLICATION CODE PINS sorts first and can never be the one
--      deleted. lib/content/okf/import.ts exports that literal as
--      ATRIUM_IMPORT_AGENT_ID and writes it straight into
--      content_publish_requests.requested_by_agent_id without a lookup, so if
--      a duplicate `atrium-importer` ever outranked it every OKF import would
--      start failing on an FK violation. This is the only id any code pins;
--      the predicate is a no-op for every other name.
--   b. `(oauth_client_id IS NULL)` ascending -> rows BOUND to an OIDC client
--      sort first. Deleting a bound row would break that agent's
--      client-credentials authentication, so a bound row always wins over an
--      unbound one.
--   c. `created_at` ascending -> the oldest row wins. On prod that is the row
--      copied from dev, so dev and prod converge on the same identity rather
--      than diverging further.
--   d. `id` ascending -> a total order, so the choice is deterministic even
--      when (a)-(c) tie.
--
-- NOT ATOMIC, BY CONSTRUCTION. infra/database/lambda/db-init-handler.ts issues
-- each statement as its own RDS Data API ExecuteStatementCommand, so the
-- repoints, the delete and the index each commit separately (this is also why
-- the canonical rule is repeated per statement rather than staged in a TEMP
-- table — a temp table would not survive between calls). Every statement is
-- individually idempotent and they are ordered so a crash midway leaves the
-- database consistent: partially-repointed rows already point at the row the
-- next run will re-select as canonical.
--
-- FAIL-LOUD. If step 1/2 somehow left a duplicate behind, CREATE UNIQUE INDEX
-- raises "could not create unique index ... is duplicated", which matches
-- neither the "already exists" nor the CREATE TYPE / ALTER TABLE special cases
-- in scripts/db/run-migrations.ts or infra/database/lambda/db-init-handler.ts.
-- The deploy fails instead of silently shipping an unenforced invariant.
--
-- IDEMPOTENT. On an environment with no duplicates the UPDATE/DELETE statements
-- match zero rows and the index is created once (IF NOT EXISTS). Plain
-- (non-CONCURRENT) CREATE UNIQUE INDEX: CONCURRENTLY is rejected by the db-init
-- validator, and this table holds single-digit rows.
--
-- Plain SQL statements only -- no PL/pgSQL anonymous blocks, which the db-init
-- statement splitter cannot parse (it enters block mode only on
-- CREATE TYPE/FUNCTION and DROP TYPE).

-- ---------------------------------------------------------------------------
-- 1) Repoint FK references from duplicate rows to the canonical row per name.
-- ---------------------------------------------------------------------------

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
)
UPDATE content_objects t
SET created_by_agent_id = d.keep_id
FROM dupes d
WHERE t.created_by_agent_id = d.dup_id;

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
)
UPDATE content_versions t
SET author_agent_id = d.keep_id
FROM dupes d
WHERE t.author_agent_id = d.dup_id;

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
)
UPDATE content_audit_logs t
SET agent_id = d.keep_id
FROM dupes d
WHERE t.agent_id = d.dup_id;

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
)
UPDATE content_publish_requests t
SET requested_by_agent_id = d.keep_id
FROM dupes d
WHERE t.requested_by_agent_id = d.dup_id;

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
)
UPDATE atrium_doc_comments t
SET author_agent_id = d.keep_id
FROM dupes d
WHERE t.author_agent_id = d.dup_id;

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
)
UPDATE content_assets t
SET uploader_agent_id = d.keep_id
FROM dupes d
WHERE t.uploader_agent_id = d.dup_id;

-- ---------------------------------------------------------------------------
-- 2) Delete the duplicates (now unreferenced by any FK).
-- ---------------------------------------------------------------------------

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
)
DELETE FROM agent_identities a
USING canon c
WHERE c.name = a.name
  AND a.id <> c.id;

-- ---------------------------------------------------------------------------
-- 3) Enforce one row per name from here on.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_identities_name
  ON agent_identities (name);
