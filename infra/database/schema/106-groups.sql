-- Migration 106: Google Directory group-sync foundation (Epic #1202, Phase 0 / #1203)
--
-- Google Workspace group membership becomes first-class data in AI Studio via a
-- scheduled service-account Directory sync. Authentication does NOT change —
-- Cognito + Google OIDC stay exactly as deployed; groups arrive out-of-band via an
-- hourly sync Lambda. Three tables land here:
--
--   groups                — one row per synced Google group. `group_email` is the
--                           stable identifier (lowercased — Google emails are
--                           case-insensitive and email is becoming an authorization
--                           join key). `source` records HOW the group entered the
--                           selection: 'manual' (a hand-picked email) or 'prefix'
--                           (matched a prefix rule); a pick wins if a group matches
--                           both. `last_synced_at` / `last_sync_error` drive the
--                           admin sync-status view. `is_active` is flipped false
--                           when a group falls out of the selection (never hard
--                           deleted, so last-known-good membership survives).
--
--   group_members         — one row per (group, member email). Membership is keyed
--                           by EMAIL, not a users FK, so people who have never
--                           signed in still sync; joins to `users` resolve lazily by
--                           lower(email). Membership is TRANSITIVE (nested groups are
--                           flattened during sync). Reconciliation full-replaces a
--                           group's rows inside a transaction, so `created_at` is the
--                           only timestamp (a full-replace makes updated_at
--                           meaningless — hence no updated_at column and no trigger
--                           on this table).
--
--   group_selection_rules — admin-editable selection config. Both modes coexist:
--                           'pick' rows name an exact group email; 'prefix' rows name
--                           an email prefix (client-side startsWith match). Toggling
--                           is_active retires a rule without losing its history, so
--                           this table DOES carry updated_at + the trigger.
--
-- Emails are lowercased on every write; the unique/lookup indexes are on
-- lower(<email>) as a defense-in-depth backstop against any non-normalized write.
--
-- ADDITIVE and idempotent (IF NOT EXISTS, mirroring 090/094/095/096). No PL/pgSQL
-- DO $$ blocks — the migration runner's statement splitter cannot handle
-- dollar-quoted blocks (see 079/085/086). updated_at is backed by the pre-existing
-- update_updated_at_column() trigger function (migration 017); single-statement
-- CREATE TRIGGER needs no dollar-quoting (proven by 028/085/086/096).

-- ---------------------------------------------------------------------------
-- groups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identifier. Stored lowercase; uniqueness enforced on lower() below.
  group_email     text NOT NULL,
  -- Google group display name (nullable until first successful fetch).
  name            text,
  -- How the group entered the selection. 'manual' = hand-picked; 'prefix' =
  -- matched a prefix rule. A pick wins when a group matches both.
  source          text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'prefix')),
  -- False when the group is no longer selected. NEVER hard-deleted on an API
  -- error, so last-known-good membership survives a failed sync.
  is_active       boolean NOT NULL DEFAULT true,
  -- Last successful membership fetch. NULL until the group syncs once.
  last_synced_at  timestamptz,
  -- Last fetch error message (NULL when the last fetch succeeded). Drives the
  -- admin "failures" surface without deleting membership.
  last_sync_error text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One group per email, case-insensitive (Google emails are case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_group_email
  ON groups (lower(group_email));

-- Active-group listing for the admin browser and the sync reconciler.
CREATE INDEX IF NOT EXISTS idx_groups_is_active
  ON groups (is_active);

-- updated_at trigger (CLAUDE.md: tables with updated_at MUST have the trigger).
DROP TRIGGER IF EXISTS update_groups_updated_at ON groups;
CREATE TRIGGER update_groups_updated_at
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- group_members
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- Transitive member email, lowercased. Resolves to a users row lazily by
  -- lower(email) — a member need not have a users row yet.
  member_email text NOT NULL,
  -- Only created_at: membership is full-replaced each sync, so updated_at would
  -- always equal created_at (no trigger needed — see header).
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- At most one row per (group, member email), case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_member
  ON group_members (group_id, lower(member_email));

-- "Which groups is this email in?" — the authorization join key (Epic #1202).
CREATE INDEX IF NOT EXISTS idx_group_members_email
  ON group_members (lower(member_email));

-- FK-column index backs the ON DELETE CASCADE and per-group member listing.
CREATE INDEX IF NOT EXISTS idx_group_members_group_id
  ON group_members (group_id);

-- ---------------------------------------------------------------------------
-- group_selection_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_selection_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'pick'   → value is an exact group email (lowercased).
  -- 'prefix' → value is an email prefix (lowercased); client-side startsWith.
  rule_type  text NOT NULL CHECK (rule_type IN ('pick', 'prefix')),
  value      text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One rule per (type, value), case-insensitive — a re-add of the same pick/prefix
-- upserts into silence rather than duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_selection_rule
  ON group_selection_rules (rule_type, lower(value));

-- updated_at trigger (rules are toggled/edited in place — see header).
DROP TRIGGER IF EXISTS update_group_selection_rules_updated_at ON group_selection_rules;
CREATE TRIGGER update_group_selection_rules_updated_at
  BEFORE UPDATE ON group_selection_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
