-- Migration 109: group→role mappings + managed-role flag (Epic #1202, Phase 1 / #1204)
--
-- Google Directory group membership (synced in Phase 0 / #1203) now drives AI
-- Studio roles automatically. Two additive changes land here:
--
--   group_role_mappings  — admin-managed "members of group X get role Y". The
--                          identifier is the group EMAIL (lowercased), NOT a
--                          groups.id FK: emails are rename-safe and match how the
--                          Phase 0 tables key membership (group_members.member_email,
--                          groups.group_email). A mapping can therefore be created
--                          before the group has synced, and survives a group's
--                          deactivation/reactivation. role_id is a real FK to roles
--                          with ON DELETE CASCADE — dropping a role removes its
--                          mappings. Uniqueness is on (lower(group_email), role_id)
--                          so the same pair cannot be mapped twice, case-insensitively.
--
--   user_roles.source    — the managed-role flag. 'manual' (default) = an admin
--                          assigned the role by hand; 'group-sync' = reconciliation
--                          granted it from a group mapping. Reconciliation only ever
--                          adds/removes 'group-sync' rows and NEVER touches 'manual'
--                          rows, so a hand-assigned role always persists even after
--                          the user leaves the group. Existing rows default to
--                          'manual' (correct — they predate group sync).
--
-- ADDITIVE and idempotent (IF NOT EXISTS, mirroring 106). No PL/pgSQL DO $$ blocks
-- — the migration runner's statement splitter cannot handle dollar-quoted blocks
-- (see 079/085/086/106). The inline column CHECK and the single-statement
-- CREATE TRIGGER need no dollar-quoting. updated_at is backed by the pre-existing
-- update_updated_at_column() trigger function (migration 017). user_roles is an
-- app-owned table (already ALTERed by 017/020), so ADD COLUMN succeeds under the
-- master migration role.

-- ---------------------------------------------------------------------------
-- group_role_mappings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_role_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identifier. Stored lowercase; uniqueness enforced on lower() below.
  -- Deliberately NOT a groups(id) FK so a mapping can be added before the group
  -- syncs and survives deactivation (matches the email-keyed Phase 0 tables).
  group_email text NOT NULL,
  -- The role granted to every member of the group. Dropping the role cascades.
  role_id     integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One mapping per (group email, role), case-insensitive on the email.
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_role_mapping
  ON group_role_mappings (lower(group_email), role_id);

-- "Which roles does this group grant?" — the reconciliation join key.
CREATE INDEX IF NOT EXISTS idx_group_role_mappings_group_email
  ON group_role_mappings (lower(group_email));

-- FK-column index backs the ON DELETE CASCADE and per-role mapping listing.
CREATE INDEX IF NOT EXISTS idx_group_role_mappings_role_id
  ON group_role_mappings (role_id);

-- updated_at trigger (CLAUDE.md: tables with updated_at MUST have the trigger).
DROP TRIGGER IF EXISTS update_group_role_mappings_updated_at ON group_role_mappings;
CREATE TRIGGER update_group_role_mappings_updated_at
  BEFORE UPDATE ON group_role_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- user_roles.source — managed-role flag
-- ---------------------------------------------------------------------------
-- 'manual' (admin-assigned, the default and the value for every pre-existing row)
-- vs 'group-sync' (granted by group→role reconciliation). Reconciliation only
-- adds/removes 'group-sync' rows; 'manual' rows are never touched. The inline
-- CHECK rides on ADD COLUMN so a re-run (column already present) skips both
-- atomically — no separate, non-idempotent ADD CONSTRAINT needed.
ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'group-sync'));
