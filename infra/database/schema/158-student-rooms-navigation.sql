-- Migration 158: Student room navigation (Epic #1308 / Issue #1314)
--
-- Student room membership is resolved dynamically from the room/OneRoster
-- tables introduced by migration 157. This migration only makes the read-only
-- student experience discoverable; it grants no management capability.
--
-- Additive and idempotent. The migration runner owns transaction control.

INSERT INTO navigation_items (
  label,
  icon,
  link,
  parent_id,
  capability_id,
  requires_role,
  position,
  is_active,
  type,
  description
)
SELECT
  'My Rooms',
  'IconUsersGroup',
  '/rooms',
  (
    SELECT id
    FROM navigation_items
    WHERE label = 'Instructional' AND type = 'section'
    ORDER BY id
    LIMIT 1
  ),
  NULL,
  'student',
  20,
  true,
  'link',
  'Open classroom rooms and launch assigned assistants'
WHERE NOT EXISTS (
  SELECT 1 FROM navigation_items WHERE link = '/rooms'
);

-- ============================================
-- ROLLBACK SQL (for manual rollback if needed)
-- ============================================
-- DELETE FROM navigation_items WHERE link = '/rooms';
