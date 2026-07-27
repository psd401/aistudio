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
  it("is registered, and ordered after the rooms migration it depends on", () => {
    // Asserted by RELATIVE position, not by `slice(-2)`. The nav row this
    // migration inserts is meaningless unless 157 has already created the
    // rooms tables, and that ordering is the whole invariant. Pinning it to
    // the END of the list instead made this test fail on the next unrelated
    // migration anyone added — a false alarm that says nothing about rooms.
    const rooms = manifest.migrationFiles.indexOf("157-rooms.sql");
    const nav = manifest.migrationFiles.indexOf(
      "158-student-rooms-navigation.sql"
    );
    expect(rooms).toBeGreaterThanOrEqual(0);
    expect(nav).toBeGreaterThan(rooms);
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
