-- Migration 098: Atrium document comments / track-changes thread store (§18.1)
-- Part of Epic #1059 (Atrium comments & track-changes).
--
-- The comment MARK (lib/content/collab/comment-mark.ts) anchors a span of a
-- collaborative document to a thread by `threadId`, but the mark carries only the
-- id — the thread's BODIES (root comment + replies + resolved state) live HERE, in
-- Postgres, so they persist outside the Y.Doc CRDT and are queryable and
-- permission-gated by the content services. One row per comment (root or reply):
--   * parent_id IS NULL  → the thread ROOT (one per thread_id).
--   * parent_id = <root> → a reply, ON DELETE CASCADE with its root.
-- `thread_id` matches the ProseMirror comment mark's `data-thread-id`; it is a
-- client-minted uuid, NOT this table's `id`, so the anchor (in the Y.Doc) and this
-- store are joined by `thread_id`, never by row id.
--
-- `resolved` is thread-level state, MIRRORED onto every row of the thread (the
-- resolve action writes all rows of a thread at once). The reader counts the
-- number of OPEN threads via the (object_id, resolved) index, filtering to the
-- roots (parent_id IS NULL) in the query.
--
-- Authorship mirrors content_versions / content_audit_logs: `author_user_id` for a
-- human (or a delegated agent's human), `author_agent_id` for an autonomous agent,
-- `author_label` as a denormalized display label. Both author FKs ON DELETE SET
-- NULL so a thread survives a deleted principal; `object_id` ON DELETE CASCADE so a
-- deleted document takes its comments with it.
--
-- ADDITIVE and idempotent (IF NOT EXISTS, mirroring 090/094/095/096). No DO $$
-- blocks — the migration runner's statement splitter cannot handle dollar-quoted
-- blocks (see 079/085/086). updated_at is backed by the pre-existing
-- update_updated_at_column() trigger function (migration 017); a single-statement
-- CREATE TRIGGER needs no dollar-quoting (proven by 028/085/086/096).

CREATE TABLE IF NOT EXISTS atrium_doc_comments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id            uuid NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  -- The ProseMirror comment mark's threadId (a client-minted uuid), NOT this row id.
  thread_id            uuid NOT NULL,
  -- NULL = the thread root; otherwise the root row this reply hangs under.
  parent_id            uuid REFERENCES atrium_doc_comments(id) ON DELETE CASCADE,
  body                 text NOT NULL,
  -- Human author (or a delegated agent's human); NULL for an autonomous agent.
  author_user_id       integer REFERENCES users(id) ON DELETE SET NULL,
  -- Autonomous agent identity, when the author is one.
  author_agent_id      uuid REFERENCES agent_identities(id) ON DELETE SET NULL,
  -- Denormalized display label (an agent label, or a captured human name).
  author_label         text,
  -- Thread-level resolved state, mirrored onto every row of the thread.
  resolved             boolean NOT NULL DEFAULT false,
  resolved_by_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now()
);

-- Thread lookup: list every row of a document's thread (root + replies) by id, and
-- back the per-object grouping the reader panel does.
CREATE INDEX IF NOT EXISTS idx_adc_object_thread
  ON atrium_doc_comments (object_id, thread_id);

-- Unresolved-root count for the reader's comment gutter: (object_id, resolved)
-- backs the count of OPEN threads (query filters to parent_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_adc_object_resolved
  ON atrium_doc_comments (object_id, resolved);

-- Exactly ONE root row per (object, thread). The surfaces accept a caller-supplied
-- threadId (the comment mark's id), so a retried create must not fabricate a second
-- root — that would make reply/resolve pick an arbitrary root. A partial UNIQUE index
-- on the roots enforces one-root-per-thread at the DB; the create action treats a
-- conflict as an idempotent no-op (returns the existing thread).
CREATE UNIQUE INDEX IF NOT EXISTS uq_adc_thread_root
  ON atrium_doc_comments (object_id, thread_id)
  WHERE parent_id IS NULL;

-- updated_at trigger (CLAUDE.md: tables with updated_at MUST have the trigger).
DROP TRIGGER IF EXISTS update_atrium_doc_comments_updated_at ON atrium_doc_comments;
CREATE TRIGGER update_atrium_doc_comments_updated_at
  BEFORE UPDATE ON atrium_doc_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
