-- Migration 107: Admin navigation entry for Google Directory group sync (#1203)
--
-- Makes /admin/groups discoverable under the Admin section. Modeled on 096's
-- Atrium-Oversight nav INSERT: a `type='link'` row nested under the '/admin'
-- parent (resolved by link, not a hard-coded id, so a fresh local seed with
-- different ids still nests correctly), gated on requires_role='administrator'
-- — matching the page's own `requireRole("administrator")` gate. 'IconUsersGroup'
-- is a registered icon-map name (components/navigation/icon-map.ts); unknown
-- names fall back to IconHome.
--
-- ADDITIVE and idempotent (WHERE NOT EXISTS on the link). No PL/pgSQL DO $$ blocks
-- (the migration runner's statement splitter cannot handle dollar-quoted blocks —
-- see 085/086/090). INSERTs into the postgres-owned navigation_items table are
-- fine under the master migration role (only ALTER on postgres-owned objects is
-- restricted).

INSERT INTO navigation_items (label, icon, link, parent_id, requires_role, position, is_active, type, description)
SELECT 'Groups', 'IconUsersGroup', '/admin/groups',
       (SELECT id FROM navigation_items WHERE link = '/admin' LIMIT 1),
       'administrator', 30, true, 'link',
       'Manage Google Directory group sync — selection rules, sync status, and the group/member browser'
WHERE NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/admin/groups'
);
