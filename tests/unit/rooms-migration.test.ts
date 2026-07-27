import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const migrationPath = path.join(
  root,
  "infra/database/schema/157-rooms.sql"
);
const migration = readFileSync(migrationPath, "utf8");
const manifest = JSON.parse(
  readFileSync(
    path.join(root, "infra/database/migrations.json"),
    "utf8"
  )
) as { migrationFiles: string[] };

describe("migration 157 — teacher-managed rooms", () => {
  it("is registered after the OneRoster role-source migration", () => {
    // Asserted by RELATIVE position, not by a `slice` anchored to the end of
    // the list. Rooms depend on the OneRoster role source having landed first;
    // where the pair happens to sit relative to the LAST migration is not part
    // of that contract, and pinning it there made this test fail on the next
    // unrelated migration anyone added.
    const oneRoster = manifest.migrationFiles.indexOf(
      "156-oneroster-user-role-source.sql"
    );
    const rooms = manifest.migrationFiles.indexOf("157-rooms.sql");
    expect(oneRoster).toBeGreaterThanOrEqual(0);
    expect(rooms).toBeGreaterThan(oneRoster);
  });

  it.each(["rooms", "room_classes", "room_members", "room_resources"])(
    "creates %s additively",
    (table) => {
      expect(migration).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`)
      );
    }
  );

  it("enforces ownership, source-key, email, and assistant constraints", () => {
    expect(migration).toContain(
      "created_by  integer REFERENCES users(id) ON DELETE SET NULL"
    );
    expect(migration).toContain(
      "room_id           uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE"
    );
    expect(migration).toContain(
      "ON room_classes (room_id, class_sourced_id)"
    );
    expect(migration).toContain(
      "ON room_members (room_id, lower(member_email))"
    );
    expect(migration).toContain(
      "member_email = lower(btrim(member_email))"
    );
    expect(migration).toContain(
      "resource_type  text NOT NULL CHECK (resource_type = 'assistant')"
    );
    expect(migration).toContain(
      "ON room_resources (room_id, resource_type, resource_id)"
    );
  });

  it("indexes every FK/source lookup and maintains rooms.updated_at", () => {
    for (const indexName of [
      "idx_rooms_created_by",
      "idx_room_classes_room_id",
      "idx_room_classes_class_sourced_id",
      "idx_room_members_room_id",
      "idx_room_members_email",
      "idx_room_resources_room_id",
      "idx_room_resources_resource",
    ]) {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    }
    expect(migration).toContain(
      "CREATE TRIGGER update_rooms_updated_at"
    );
    expect(migration).toContain(
      "FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()"
    );
  });

  it("seeds capability-gated room navigation for fresh databases", () => {
    expect(migration).toContain("'rooms-manage'");
    expect(migration).toContain("JOIN roles ON roles.name IN ('administrator', 'staff')");
    expect(migration).toContain("'Rooms'");
    expect(migration).toContain("'IconUsersGroup'");
    expect(migration).toContain("'/rooms/manage'");
    expect(migration).toContain("capabilities.id");
  });

  it("remains splitter-compatible, excludes demographics, and documents rollback", () => {
    expect(migration).not.toMatch(/\bDO\s+\$\$/i);
    expect(migration).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(migration).not.toMatch(/demographic/i);
    for (const table of [
      "room_resources",
      "room_members",
      "room_classes",
      "rooms",
    ]) {
      expect(migration).toContain(`-- DROP TABLE IF EXISTS ${table};`);
    }
  });
});
