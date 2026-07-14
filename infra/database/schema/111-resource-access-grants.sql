-- Migration 111: per-resource role/group access grants (Epic #1202, Phase 3 / #1206)
--
-- A single generic grant table that keys direct access on individual AI Studio
-- resources — models, Assistant Architect assistants, and agent skills — to a
-- ROLE (by name) or a synced Google Directory GROUP (by email). This is the
-- third, resource-scoped authorization axis (distinct from role-gated UI
-- Capabilities and API-key Scopes — see docs/architecture/capabilities-and-scopes.md);
-- do NOT collapse it into either.
--
--   resource_access_grants — one row per (resource, grant_kind, grant_value).
--
-- SEMANTICS (mirrors today's ai_models.allowed_roles contract exactly):
--   * ZERO grant rows for a resource  = UNRESTRICTED (everyone may access).
--   * ANY matching grant row          = allowed. A `role` grant matches when the
--     user holds that role (by NAME, case-insensitively — matched against
--     roles.name via user_roles); a `group` grant matches when the user is a
--     transitive member of that ACTIVE synced group (group_members joined on the
--     user's lowercased email → groups.group_email = grant_value).
--   * ADMINISTRATORS always pass, regardless of grants.
--
-- grant_value per kind (documented here so writers normalize before storing):
--   * grant_kind='role'  → the role NAME (e.g. 'staff'). Matched case-insensitively
--     (lower() on both sides), so casing at write time never authorizes/denies by
--     accident. Do NOT store a role id — the match is by name.
--   * grant_kind='group' → the synced Google group EMAIL, LOWERCASED
--     (e.g. 'hs-staff@psd401.net'). Emails are case-insensitive; stored lowercase
--     so exact-match reads hit the lookup index and align with the email-keyed
--     Phase 0 tables (group_members.member_email, groups.group_email).
--
-- resource_id is TEXT, not integer. The design note in #1206 said `integer`, but
-- psd_agent_skills.id is a UUID (models/assistants are serial ints), so a single
-- shared column MUST be text to key all three resource types. Integer ids are
-- stored as their decimal text (e.g. '42'); skill ids as the uuid string. The
-- lookup helper (lib/db/drizzle/resource-access.ts) stringifies the id before
-- every comparison, so callers pass a number or a uuid transparently.
--
-- ADDITIVE and idempotent (IF NOT EXISTS, mirroring 106/109). resource_type and
-- grant_kind are VARCHAR + inline CHECK constraints, NOT PostgreSQL enums —
-- matching the psd_agent_skills scope/scan_status precedent (migration 070): the
-- db-init Lambda's SQL splitter cannot reliably run DROP TYPE during recovery, so
-- new enums are avoided for app-owned tables. No PL/pgSQL DO $$ blocks — the
-- splitter only enters block mode on CREATE TYPE/FUNCTION/DROP TYPE (see
-- 079/085/086/106); every statement below is an ordinary single statement.
-- created_at is the only timestamp: a grant is immutable once created (edited via
-- delete-then-insert), so there is no updated_at column and no trigger.

-- ---------------------------------------------------------------------------
-- resource_access_grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_access_grants (
  id            serial PRIMARY KEY,
  -- Which kind of resource this grant applies to.
  resource_type varchar(16) NOT NULL
                CHECK (resource_type IN ('model', 'assistant', 'skill')),
  -- The resource's primary key, as text (serial int → decimal text; skill uuid →
  -- uuid string). See header for why this is text, not integer.
  resource_id   text NOT NULL,
  -- The access dimension: a role (by name) or a synced group (by email).
  grant_kind    varchar(16) NOT NULL
                CHECK (grant_kind IN ('role', 'group')),
  -- The value to match. 'role' → role name; 'group' → lowercased group email.
  grant_value   text NOT NULL,
  -- The admin who created the grant (NULL for the ai_models.allowed_roles
  -- backfill below, which has no acting user). SET NULL on user delete so a
  -- departed admin's grants survive.
  created_by    integer REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one identical grant per resource (matches the delete-then-insert write
-- path and guards direct SQL / future writers against duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_access_grant
  ON resource_access_grants (resource_type, resource_id, grant_kind, grant_value);

-- "Which grants does this resource have?" — the per-resource lookup the access
-- helper and the admin grants editor both drive.
CREATE INDEX IF NOT EXISTS idx_resource_access_grants_resource
  ON resource_access_grants (resource_type, resource_id);

-- ---------------------------------------------------------------------------
-- Backfill: ai_models.allowed_roles → resource_access_grants (grant_kind='role')
-- ---------------------------------------------------------------------------
-- Preserve today's model access EXACTLY. A model whose allowed_roles is a
-- non-empty jsonb array of role names becomes one 'role' grant per name; a model
-- with NULL / non-array / empty allowed_roles gets NO rows and stays unrestricted
-- (the zero-rows = unrestricted semantics reproduce the prior "no restriction"
-- behavior). allowed_roles is INTENTIONALLY NOT dropped here — read paths move to
-- this table first; the column is retired in Phase 4 (#1207). Idempotent via
-- ON CONFLICT so a re-run adds nothing.
INSERT INTO resource_access_grants (resource_type, resource_id, grant_kind, grant_value)
SELECT 'model', m.id::text, 'role', role_name
  FROM ai_models m,
       LATERAL jsonb_array_elements_text(m.allowed_roles) AS role_name
 WHERE m.allowed_roles IS NOT NULL
   AND jsonb_typeof(m.allowed_roles) = 'array'
   AND jsonb_array_length(m.allowed_roles) > 0
   AND length(trim(role_name)) > 0
ON CONFLICT (resource_type, resource_id, grant_kind, grant_value) DO NOTHING;
