-- Migration 157: Teacher-managed rooms (Epic #1308 / Issue #1313)
--
-- Rooms are application-owned containers that compose synced OneRoster class
-- sections, explicit student email addresses, and assigned AI Studio resources.
-- The OneRoster rows remain sync-owned and are referenced by sourced ID rather
-- than foreign key so a roster refresh or soft deletion cannot destroy a room.
--
-- Child rows are full-replaced inside the room mutation transaction. As with
-- group_members (migration 106), they therefore carry created_at only:
-- updated_at would always equal created_at and would add meaningless triggers.
--
-- Additive and idempotent. No transaction control or dollar-quoted blocks are
-- used because the migration runner owns the transaction and statement split.

CREATE TABLE IF NOT EXISTS rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 120
  ),
  created_by  integer REFERENCES users(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rooms_created_by
  ON rooms (created_by);

CREATE INDEX IF NOT EXISTS idx_rooms_is_active
  ON rooms (is_active);

DROP TRIGGER IF EXISTS update_rooms_updated_at ON rooms;
CREATE TRIGGER update_rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS room_classes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  class_sourced_id  text NOT NULL CHECK (btrim(class_sourced_id) <> ''),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_class
  ON room_classes (room_id, class_sourced_id);

CREATE INDEX IF NOT EXISTS idx_room_classes_room_id
  ON room_classes (room_id);

CREATE INDEX IF NOT EXISTS idx_room_classes_class_sourced_id
  ON room_classes (class_sourced_id);

CREATE TABLE IF NOT EXISTS room_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_email  text NOT NULL CHECK (
    member_email = lower(btrim(member_email))
    AND member_email <> ''
  ),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_member
  ON room_members (room_id, lower(member_email));

CREATE INDEX IF NOT EXISTS idx_room_members_room_id
  ON room_members (room_id);

CREATE INDEX IF NOT EXISTS idx_room_members_email
  ON room_members (lower(member_email));

CREATE TABLE IF NOT EXISTS room_resources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  resource_type  text NOT NULL CHECK (resource_type = 'assistant'),
  resource_id    text NOT NULL CHECK (
    resource_id ~ '^[1-9][0-9]*$'
  ),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_resource
  ON room_resources (room_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_room_resources_room_id
  ON room_resources (room_id);

CREATE INDEX IF NOT EXISTS idx_room_resources_resource
  ON room_resources (resource_type, resource_id);

-- ============================================
-- ROLLBACK SQL (for manual rollback if needed)
-- ============================================
-- DROP TABLE IF EXISTS room_resources;
-- DROP TABLE IF EXISTS room_members;
-- DROP TABLE IF EXISTS room_classes;
-- DROP TABLE IF EXISTS rooms;
