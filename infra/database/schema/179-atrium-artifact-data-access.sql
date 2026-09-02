-- ============================================================================
-- 179 — Atrium artifact data access mode (#1705)
-- ============================================================================
--
-- Adds `content_objects.data_access`, the per-artifact switch that decides
-- WHICH sandbox data bridge operation an artifact may use:
--
--   'records' — the #1516 artifact records store (AtriumData.submit / .list).
--               This is the DEFAULT so every artifact created before this
--               migration keeps working byte-for-byte.
--   'query'   — viewer-scoped, read-only PSD Data MCP queries
--               (AtriumData.query), executed as the person VIEWING the page.
--   'none'    — no data bridge operation at all.
--
-- The modes are mutually EXCLUSIVE by design, and that exclusivity is a
-- security control, not a UX preference. `AtriumData.submit` writes rows that
-- any viewer can read back through `list({scope:"all"})` and that the artifact
-- OWNER can read out-of-band. If one artifact could both query as the viewer
-- and submit records, a hostile author would have a working exfiltration loop:
-- query the viewer's rows, submit them into a namespace, read them back as the
-- author. Every other egress path out of the sandbox is already closed
-- (connect-src 'none', img-src without an https wildcard, form-action 'none',
-- sandbox="allow-scripts" with no navigation/popups), so this column is the
-- one remaining gate. Do NOT relax it to "both" without redesigning the
-- records store's readback rules.
--
-- Migration-runner notes:
--   * The `CREATE TYPE` is a bare, single-line statement — NO PL/pgSQL `DO $$`
--     block. The db-init splitter enters block mode on a line starting with
--     CREATE TYPE and leaves it on the line ending `);`, so a one-line enum
--     splits correctly; a `DO $$` block would not (see migrations 095 / 110).
--   * Re-running is safe: the runner explicitly swallows a `CREATE TYPE ...
--     already exists` error for a manifest migration, and the ALTER TABLE uses
--     ADD COLUMN IF NOT EXISTS.
--   * The column is NOT NULL with a DEFAULT, so existing rows are backfilled by
--     the default itself — no separate UPDATE pass.
-- ============================================================================

CREATE TYPE content_data_access AS ENUM ('records', 'query', 'none');

ALTER TABLE content_objects
  ADD COLUMN IF NOT EXISTS data_access content_data_access
  NOT NULL DEFAULT 'records';

COMMENT ON COLUMN content_objects.data_access IS
  'Which Atrium sandbox data bridge operation this artifact may use: records (AtriumData.submit/list, the default), query (viewer-scoped PSD Data MCP reads), or none. Mutually exclusive by design - see migration 179 and docs/features/atrium-artifact-data.md.';

-- ROLLBACK SQL (for manual rollback if needed)
-- ALTER TABLE content_objects DROP COLUMN IF EXISTS data_access;
-- DROP TYPE IF EXISTS content_data_access;
