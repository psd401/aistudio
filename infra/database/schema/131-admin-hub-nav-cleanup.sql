-- ============================================================================
-- 131: Admin hub navigation cleanup
-- ============================================================================
-- The /admin route is now a hub page (app/(protected)/admin/page.tsx) whose
-- cards are driven by the ADMIN_SECTIONS registry in code. The sidebar keeps a
-- single "Admin" entry pointing at /admin; the per-page rows that migrations
-- 049/053/083/097/107 (and hand-edits via /admin/navigation) accumulated are
-- retired here. Fresh installs run this after those migrations, so they land
-- in the same end state.
--
-- No DO $$ blocks — the local db-init statement splitter cannot parse them.

-- 1) Repoint the existing Admin entry (seeded as a link in 005, commonly
--    converted to an empty section in live environments) at the hub page.
UPDATE navigation_items
SET link = '/admin',
    type = 'link',
    is_active = true,
    description = 'All administration pages in one place'
WHERE requires_role = 'administrator'
  AND label = 'Admin'
  AND (link IS NULL OR link IN ('', '/admin'));

-- 2) Guarantee a hub entry exists even if step 1 matched nothing (e.g. the
--    environment renamed the Admin row).
INSERT INTO navigation_items (label, icon, link, position, type, requires_role, is_active, description)
SELECT 'Admin', 'IconShield', '/admin', 80, 'link', 'administrator', true,
       'All administration pages in one place'
WHERE NOT EXISTS (SELECT 1 FROM navigation_items WHERE link = '/admin');

-- 3) Retire every per-page admin nav row (the hub links to them instead).
--    navigation_item_roles has no FK, so clear its rows explicitly first.
DELETE FROM navigation_item_roles
WHERE navigation_item_id IN (
  SELECT id FROM navigation_items WHERE link LIKE '/admin/%'
);

DELETE FROM navigation_items
WHERE link LIKE '/admin/%';

-- 4) Deactivate any now-childless administrator-only section (covers a renamed
--    Admin section that step 1 could not match; harmless if none exist).
UPDATE navigation_items
SET is_active = false
WHERE type = 'section'
  AND requires_role = 'administrator'
  AND NOT EXISTS (
    SELECT 1 FROM navigation_items c
    WHERE c.parent_id = navigation_items.id
      AND c.is_active
  );
