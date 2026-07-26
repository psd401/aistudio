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
-- WHAT THIS DOES, IN ONE STATEMENT.
--   1. Repoints every FK reference away from duplicate rows onto one canonical
--      row per name.
--   2. Deletes the now-unreferenced duplicates.
--   3. (Second statement) Adds a UNIQUE index on `name`, so no future seeding
--      path — migration, script, data copy, or application code — can create a
--      second row for a name regardless of what id it picks. This replaces
--      three racy read-then-write guards with one database-enforced invariant.
--
-- WHY ONE STATEMENT, AND WHY `FOR UPDATE`. This is the correctness crux, so it
-- is spelled out. infra/database/lambda/db-init-handler.ts issues each
-- statement as its own RDS Data API ExecuteStatementCommand, and the Data API
-- gives no way to span a transaction across calls (a bare `BEGIN;` would not
-- persist). Written as seven statements — six repoints then a delete — the
-- migration has a window against a LIVE application: a request can resolve a
-- soon-to-be-deleted identity and insert an audit log, publish request, comment
-- or asset AFTER that table's repoint has already committed. Every one of those
-- FKs is `ON DELETE SET NULL`, so the delete would then SILENTLY erase the new
-- row's agent attribution instead of failing.
--
-- So the repoints and the delete are a SINGLE statement built from
-- data-modifying CTEs. One statement is one transaction, which closes the
-- window for everything already committed at the statement's snapshot. The
-- remaining hazard — a writer that commits AFTER the snapshot but BEFORE the
-- delete reaches the parent row — is closed by `FOR UPDATE OF a` in the
-- `dupes` CTE: inserting a child row takes a FOR KEY SHARE lock on the parent,
-- which conflicts with FOR UPDATE, so any such writer BLOCKS until this
-- statement commits and then fails loudly on a foreign-key violation rather
-- than losing its attribution silently. `dupes` is declared MATERIALIZED so the
-- lock is genuinely taken before the dependent CTEs run, not inlined into each.
--
-- No quiesce window is therefore required to deploy this.
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
-- FAIL-LOUD. If the dedupe somehow left a duplicate behind, CREATE UNIQUE INDEX
-- raises "could not create unique index ... is duplicated", which matches
-- neither the "already exists" nor the CREATE TYPE / ALTER TABLE special cases
-- in scripts/db/run-migrations.ts or infra/database/lambda/db-init-handler.ts.
-- The deploy fails instead of silently shipping an unenforced invariant.
--
-- IDEMPOTENT. On an environment with no duplicates `dupes` is empty, so every
-- CTE touches zero rows and takes no locks, and the index is created once
-- (IF NOT EXISTS). Plain (non-CONCURRENT) CREATE UNIQUE INDEX: CONCURRENTLY is
-- rejected by the db-init validator, and this table holds single-digit rows.
--
-- Plain SQL statements only -- no PL/pgSQL anonymous blocks, which the db-init
-- statement splitter cannot parse (it enters block mode only on
-- CREATE TYPE/FUNCTION and DROP TYPE).

-- ---------------------------------------------------------------------------
-- 1) Repoint every FK reference onto the canonical row, then delete the
--    duplicates -- atomically, and holding a lock that blocks new references.
-- ---------------------------------------------------------------------------

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
), dupes AS MATERIALIZED (
  SELECT a.id AS dup_id, c.id AS keep_id
  FROM agent_identities a
  JOIN canon c ON c.name = a.name
  WHERE a.id <> c.id
  FOR UPDATE OF a
), repoint_objects AS (
  UPDATE content_objects t
  SET created_by_agent_id = d.keep_id
  FROM dupes d
  WHERE t.created_by_agent_id = d.dup_id
  RETURNING 1
), repoint_versions AS (
  UPDATE content_versions t
  SET author_agent_id = d.keep_id
  FROM dupes d
  WHERE t.author_agent_id = d.dup_id
  RETURNING 1
), repoint_audit AS (
  UPDATE content_audit_logs t
  SET agent_id = d.keep_id
  FROM dupes d
  WHERE t.agent_id = d.dup_id
  RETURNING 1
), repoint_publish_requests AS (
  UPDATE content_publish_requests t
  SET requested_by_agent_id = d.keep_id
  FROM dupes d
  WHERE t.requested_by_agent_id = d.dup_id
  RETURNING 1
), repoint_comments AS (
  UPDATE atrium_doc_comments t
  SET author_agent_id = d.keep_id
  FROM dupes d
  WHERE t.author_agent_id = d.dup_id
  RETURNING 1
), repoint_assets AS (
  UPDATE content_assets t
  SET uploader_agent_id = d.keep_id
  FROM dupes d
  WHERE t.uploader_agent_id = d.dup_id
  RETURNING 1
)
DELETE FROM agent_identities a
USING dupes d
WHERE a.id = d.dup_id;

-- ---------------------------------------------------------------------------
-- 2) Enforce one row per name from here on.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_identities_name
  ON agent_identities (name);
