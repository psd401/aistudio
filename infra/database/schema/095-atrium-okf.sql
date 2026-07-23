-- Migration 095: Atrium Phase 8 — OKF interoperability
-- Issue #1103 (Epic #1059, spec §36). Adds the `okf` publish destination and the
-- seeded `atrium-importer` agent identity that stamps agent provenance on every
-- OKF-imported object/version.
--
-- NOTES for the RDS Data API migration runner's statement splitter:
--   * No PL/pgSQL `DO $$` blocks and no inner `CREATE TYPE` — the splitter only
--     enters block mode on CREATE TYPE/FUNCTION/DROP TYPE, so the ALTER TYPE and
--     the INSERT below are each treated as ordinary single statements.
--   * `ALTER TYPE ... ADD VALUE` is run as its own auto-committed statement (the
--     runner does not wrap the file in one transaction), so the "ADD VALUE cannot
--     run in a transaction block" pitfall does not apply. The new value is NOT used
--     elsewhere in this file, so there is no same-transaction-use problem either.
--   * `publish_destination` is master-owned (created in the 085 Atrium migration,
--     NOT an immutable 001-005 postgres-owned type), so ADD VALUE succeeds under
--     the migration role on Aurora.

-- 1. The OKF export destination. Idempotent (IF NOT EXISTS) so a re-run is a no-op.
ALTER TYPE publish_destination ADD VALUE IF NOT EXISTS 'okf';

-- 2. The `atrium-importer` agent identity. Import writes are authored as THIS
--    identity so imported content carries actor_kind = 'agent' provenance
--    regardless of who triggered the import (spec §36.3). A FIXED id is used so
--    lib/content/okf/import.ts (ATRIUM_IMPORT_AGENT_ID) can attribute the FK
--    without a runtime lookup. Conservative scopes: create + update content only
--    (never content:publish_public). role_id → 'staff' so any content it authors
--    reads at staff-level visibility (NULL-safe subquery). Idempotent on the id.
INSERT INTO agent_identities (id, name, kind, role_id, scopes, is_active)
SELECT '0a710f00-0000-4000-a000-000000000f36', 'atrium-importer', 'service',
       (SELECT id FROM roles WHERE name = 'staff' LIMIT 1),
       ARRAY['content:create', 'content:update'], true
WHERE NOT EXISTS (
  SELECT 1 FROM agent_identities WHERE id = '0a710f00-0000-4000-a000-000000000f36'
);
