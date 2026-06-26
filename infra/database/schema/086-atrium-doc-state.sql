-- Migration 086: Atrium live collaborative document state (Yjs CRDT)
-- Part of #1051 (Epic #1059, Atrium Phase 1 — document path + real-time collab)
--
-- Phase 1 builds the live collaborative document surface. Each Atrium *document*
-- content object has one live Yjs CRDT doc, edited in real time by humans (green
-- provenance) and agents (purple). This table is the durable home of that CRDT
-- state between edit sessions: the Hocuspocus collab server hydrates a doc's
-- Y.Doc from `y_state` on first connection (onLoadDocument) and persists the
-- encoded state back here, debounced, on change (onStoreDocument). Cross-instance
-- fan-out across ECS tasks runs through Redis; this table is the source of truth
-- on cold load and the input to immutable version snapshots (content_versions).
--
-- The canonical markdown projection is derived from the Y.Doc and mirrored into
-- `markdown` so the reader/snapshot path can read legible content without
-- standing up a Yjs runtime. `revision` is a monotonic persist counter, used as
-- an optimistic-concurrency token by the agent bridge.
--
-- ADDITIVE and idempotent. No DO $$ blocks (the migration runner's statement
-- splitter cannot handle dollar-quoted blocks — see migration 079/085). The
-- `updated_at` column is backed by the pre-existing `update_updated_at_column()`
-- trigger function (migration 017); a single-statement CREATE TRIGGER needs no
-- dollar-quoting, so the splitter handles it (proven by 028/085). App code still
-- sets `updatedAt` explicitly via Drizzle as the fast path; the trigger is the
-- DB-level backstop.

-- ============================================================================
-- 1. atrium_doc_state — one live Yjs CRDT doc per document content object.
--    object_id is both PK and FK; ON DELETE CASCADE drops the live state when
--    the content object is removed (immutable history in content_versions is
--    unaffected — those rows are the durable record).
-- ============================================================================
CREATE TABLE IF NOT EXISTS atrium_doc_state (
  object_id uuid PRIMARY KEY REFERENCES content_objects(id) ON DELETE CASCADE,
  -- Encoded full Y.Doc state (Y.encodeStateAsUpdate). postgres.js returns bytea
  -- as a Buffer (Uint8Array subclass), directly consumable by Y.applyUpdate.
  y_state bytea NOT NULL,
  -- Canonical markdown projection derived from the Y.Doc on each persist.
  markdown text NOT NULL DEFAULT '',
  -- Monotonic persist counter; optimistic-concurrency token for the agent bridge.
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. updated_at trigger (CLAUDE.md: tables with updated_at MUST have the
--    PostgreSQL trigger). References update_updated_at_column() (migration 017);
--    single-statement CREATE TRIGGER, so the runner's splitter handles it.
-- ============================================================================
DROP TRIGGER IF EXISTS update_atrium_doc_state_updated_at ON atrium_doc_state;
CREATE TRIGGER update_atrium_doc_state_updated_at
  BEFORE UPDATE ON atrium_doc_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
