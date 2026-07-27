import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const migration = readFileSync(
  path.join(
    root,
    "infra/database/schema/158-student-rooms-navigation.sql"
  ),
  "utf8"
);
const manifest = JSON.parse(
  readFileSync(
    path.join(root, "infra/database/migrations.json"),
    "utf8"
  )
) as { migrationFiles: string[] };

describe("migration 158 — student room navigation", () => {
  it("is the registered migration immediately after rooms", () => {
    const roomsIndex = manifest.migrationFiles.indexOf("157-rooms.sql");
    expect(roomsIndex).toBeGreaterThanOrEqual(0);
    expect(manifest.migrationFiles[roomsIndex + 1]).toBe(
      "158-student-rooms-navigation.sql"
    );
  });

  it("adds a student-only read route without a management capability", () => {
    expect(migration).toContain("'My Rooms'");
    expect(migration).toContain("'/rooms'");
    expect(migration).toContain("'student'");
    expect(migration).toMatch(/NULL,\s*'student',/);
    expect(migration).not.toContain("'rooms-manage'");
  });

  it("is idempotent, splitter-compatible, and documents rollback", () => {
    expect(migration).toContain(
      "WHERE NOT EXISTS (\n  SELECT 1 FROM navigation_items WHERE link = '/rooms'"
    );
    expect(migration).not.toMatch(/\bDO\s+\$\$/i);
    expect(migration).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(migration).toContain(
      "-- DELETE FROM navigation_items WHERE link = '/rooms';"
    );
  });
});
