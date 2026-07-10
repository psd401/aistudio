-- Migration 097: Atrium navigation entry
-- Part of Epic #1059 (Atrium epic completion) — makes the /atrium content
-- workspace discoverable. Migration 085 (§10b/§10c) explicitly DEFERRED
-- navigation seeding ("nav seeding + the collection↔nav wiring move to Phase 1")
-- and no later migration added it, so the feature shipped with no nav entry.
--
-- Modeling: one top-level `type='link'` row pointing at /atrium, gated on the
-- `atrium-content` CAPABILITY (navigation_items.capability_id) — the SAME
-- capability the /atrium page itself enforces (hasCapabilityAccess in
-- app/(protected)/atrium/page.tsx), whose manifest defaultRoles are
-- administrator + staff (lib/capabilities/manifest.ts). Gating the nav row on
-- the capability rather than a requires_role string means the entry tracks
-- whatever roles a district grants the capability to — exactly the set of users
-- the destination page will let in. This matches how other feature-gated nav
-- rows are modeled (013 knowledge-repositories, 057 decision-capture: nav row
-- joined to the feature's tool/capability row).
--
-- The `atrium-content` capability row is normally created by the boot-time
-- manifest sync (lib/capabilities/sync.ts) and already exists in every deployed
-- environment. On a FRESH database, migrations run before first boot, so
-- statement 1 seeds it (mirroring the manifest entry, source='code') iff absent.
-- The boot sync then treats it as already-owned (source='code', matching
-- name/description) and is a no-op. The CTE grants the manifest defaultRoles
-- ONLY when the capability row was actually inserted HERE — in an existing
-- environment (row present) nothing is granted, so an admin's deliberate role
-- revocations are never re-granted by this migration.
--
-- ADDITIVE and idempotent. No PL/pgSQL DO $$ blocks (the migration runner's
-- statement splitter cannot handle dollar-quoted blocks — see 085/086/090).
-- INSERTs into the postgres-owned navigation_items table are fine under the
-- master migration role (only ALTER on postgres-owned objects is restricted).

-- 1. Ensure the atrium-content capability exists (fresh-DB path only; the boot
--    sync owns it everywhere else). defaultRoles are granted ONLY on the insert.
WITH ins AS (
  INSERT INTO capabilities (identifier, name, description, is_active, source)
  SELECT 'atrium-content',
         'Atrium Content',
         'Create and version Atrium content objects (documents and artifacts).',
         true,
         'code'
  WHERE NOT EXISTS (
    SELECT 1 FROM capabilities WHERE identifier = 'atrium-content'
  )
  RETURNING id
)
INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, ins.id
FROM ins
JOIN roles r ON r.name IN ('administrator', 'staff')
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- 2. Top-level "Atrium" navigation link, gated on the capability (no
--    requires_role: the capability's role grants are the single source of
--    truth). Position 36 slots it directly after "Skills" (35, migration 081).
--    IconFileAnalytics is a registered icon-map name
--    (components/navigation/icon-map.ts) — unknown names fall back to IconHome.
INSERT INTO navigation_items (label, icon, link, parent_id, capability_id, requires_role, position, is_active, type, description)
SELECT 'Atrium', 'IconFileAnalytics', '/atrium', NULL, c.id, NULL, 36, true, 'link',
       'Create and manage Atrium content — documents and interactive artifacts'
FROM capabilities c
WHERE c.identifier = 'atrium-content'
  AND NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/atrium'
  );
