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
-- Six columns FK to agent_identities: content_objects.created_by_agent_id,
-- content_versions.author_agent_id, content_audit_logs.agent_id,
-- content_publish_requests.requested_by_agent_id,
-- atrium_doc_comments.author_agent_id, content_assets.uploader_agent_id.
-- (`scheduled_executions.agent_identity_id`, listed on #1303, no longer exists
-- — migration 133 dropped that table.)
--
-- ============================================================================
-- WHY THIS MIGRATION DOES NOT DELETE ANYTHING
-- ============================================================================
--
-- The obvious shape — repoint the FKs onto a canonical row, then DELETE the
-- duplicates — is NOT SAFE here, and two earlier drafts of this file got it
-- wrong in two different ways. Both failures share one root cause: EVERY ONE of
-- those six foreign keys is `ON DELETE SET NULL`, so a child row the repoint
-- misses is not rejected — it is SILENTLY stripped of its agent attribution.
-- That is exactly the class of silent failure this migration exists to prevent.
--
-- Draft 1, seven separate statements (six repoints, then the delete):
-- infra/database/lambda/db-init-handler.ts issues each statement as its own RDS
-- Data API ExecuteStatementCommand and the Data API cannot span a transaction
-- across calls, so each committed independently. Against a live application a
-- request could insert a child row referencing a duplicate AFTER that table's
-- repoint had committed; the delete then nulled it.
--
-- Draft 2, one statement of data-modifying CTEs plus `FOR UPDATE OF a`: closer,
-- but still wrong on two counts.
--   (a) A writer that took its `FOR KEY SHARE` lock just BEFORE this statement
--       began commits while the delete waits on it. The statement's snapshot
--       was already taken, so the repoint CTEs cannot see that newly committed
--       child row, and the delete nulls it anyway.
--   (b) PostgreSQL gives NO execution-order guarantee between sibling
--       data-modifying CTEs and the main query, and explicitly documents that
--       having the main query delete a parent whose FK action is ON DELETE SET
--       NULL while a WITH sub-statement touches the same child rows leaves the
--       outcome UNDEFINED. A passing test only proves the plan chosen that day.
--
-- Rather than try to out-lock a race whose safe form needs a transaction the
-- runner cannot give us, this migration REMOVES THE DELETE. Duplicates are
-- TOMBSTONED instead: renamed out of the way and deactivated.
--
--   * No row is ever deleted, so `ON DELETE SET NULL` never fires and NO child
--     row can lose its attribution — no matter how the statements interleave
--     with live traffic. The failure mode is designed out rather than guarded
--     against.
--   * A child row inserted concurrently, which the repoint therefore misses,
--     still points at a row that EXISTS. Its attribution is stale, not lost,
--     and it is trivially recoverable because the tombstone records exactly
--     which identity it was.
--   * Names become distinct, so the unique index can be created.
--   * No quiesce window, no table lock, and no reliance on undefined ordering.
--
-- Tombstones are inert: `is_active = false`, and the name is mangled so no
-- lookup by the real name can reach them. An operator can delete them later,
-- deliberately and with no live traffic — which is when a delete is safe.
--
-- CANONICAL-ROW CHOICE (ORDER BY inside the DISTINCT ON), most significant first:
--   a. `(id <> '0a710f00-0000-4000-a000-000000000f36')` ascending -> the row
--      whose id APPLICATION CODE PINS sorts first and can never be tombstoned.
--      lib/content/okf/import.ts exports that literal as ATRIUM_IMPORT_AGENT_ID
--      and writes it straight into
--      content_publish_requests.requested_by_agent_id without a lookup. This is
--      the only id any code pins; the predicate is a no-op for every other name.
--   b. `(oauth_client_id IS NULL)` ascending -> rows BOUND to an OIDC client
--      sort first. Tombstoning a bound row would break that agent's
--      client-credentials authentication.
--   c. `created_at` ascending -> the oldest row wins. On prod that is the row
--      copied from dev, so dev and prod converge rather than diverging further.
--   d. `id` ascending -> a total order, so the choice is deterministic even
--      when (a)-(c) tie.
--
-- FAIL-LOUD. If the tombstone pass somehow left two rows sharing a name,
-- CREATE UNIQUE INDEX raises "could not create unique index ... is duplicated",
-- which matches neither the "already exists" nor the CREATE TYPE / ALTER TABLE
-- special cases in scripts/db/run-migrations.ts or
-- infra/database/lambda/db-init-handler.ts. The deploy fails rather than
-- silently shipping an unenforced invariant.
--
-- IDEMPOTENT. On an environment with no duplicates every statement matches zero
-- rows and the index is created once (IF NOT EXISTS). The tombstone name embeds
-- the row's own id and the `a.id <> c.id` guard is unchanged by it, so a second
-- run cannot re-tombstone an already-tombstoned row. Plain (non-CONCURRENT)
-- CREATE UNIQUE INDEX: CONCURRENTLY is rejected by the db-init validator, and
-- this table holds single-digit rows.
--
-- Plain SQL statements only -- no PL/pgSQL anonymous blocks, which the db-init
-- statement splitter cannot parse (it enters block mode only on
-- CREATE TYPE/FUNCTION and DROP TYPE).

-- ---------------------------------------------------------------------------
-- 1) Consolidate attribution: repoint every FK reference from a duplicate row
--    onto the canonical row for that name.
--
--    Six plain UPDATEs on six DISTINCT tables, none of which fires a foreign
--    key action, so the "sibling CTE ordering is unpredictable" caveat has
--    nothing to bite on here — the sub-statements cannot interact. This pass is
--    best-effort by design: anything it misses keeps a valid pointer to the
--    tombstone, which is why step 2 must not delete.
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
)
UPDATE content_assets t
SET uploader_agent_id = d.keep_id
FROM dupes d
WHERE t.uploader_agent_id = d.dup_id;

-- ---------------------------------------------------------------------------
-- 2) Tombstone the duplicates: deactivate them and move their names aside so
--    `name` becomes unique. NOT a delete — see the header. `left(name, 150)`
--    keeps the result inside varchar(200): 150 + '#dup-' (5) + a 36-char uuid
--    = 191.
-- ---------------------------------------------------------------------------

WITH canon AS (
  SELECT DISTINCT ON (name) name, id
  FROM agent_identities
  ORDER BY name, (id <> '0a710f00-0000-4000-a000-000000000f36'), (oauth_client_id IS NULL), created_at, id
)
UPDATE agent_identities a
SET name = left(a.name, 150) || '#dup-' || a.id,
    is_active = false
FROM canon c
WHERE c.name = a.name
  AND a.id <> c.id;

-- ---------------------------------------------------------------------------
-- 3) Enforce one row per name from here on.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_identities_name
  ON agent_identities (name);
