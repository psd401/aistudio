import fs from "node:fs";
import path from "node:path";

const migrationFile = "156-oneroster-user-role-source.sql";
const migration = fs.readFileSync(
  path.join(process.cwd(), "infra/database/schema", migrationFile),
  "utf8"
);

describe("OneRoster user-role source migration", () => {
  it("widens the source constraint without changing the default owner", () => {
    expect(migration).toContain(
      "CHECK (source IN ('manual', 'group-sync', 'oneroster'))"
    );
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS user_roles_source_check"
    );
    expect(migration).not.toMatch(/ALTER COLUMN source SET DEFAULT 'oneroster'/i);
  });

  it("is splitter-safe and documents a source-scoped rollback", () => {
    expect(migration).not.toMatch(/\bDO\s+\$\$/i);
    expect(migration).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(migration).toContain(
      "WHERE source = 'oneroster'"
    );
    expect(migration).toContain(
      "SET role_version = coalesce(role_version, 0) + 1"
    );
  });

  it("is registered in the authoritative migration manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "infra/database/migrations.json"),
        "utf8"
      )
    ) as { migrationFiles: string[] };

    expect(manifest.migrationFiles).toContain(migrationFile);
  });
});
