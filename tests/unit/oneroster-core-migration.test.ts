/**
 * Contract checks for the OneRoster core schema (Epic #1308 / Issue #1309).
 *
 * The sync relies on every collection having identical bookkeeping columns,
 * sourced-id reference indexes without cross-collection foreign keys, and an
 * updated_at trigger. Keep those invariants explicit as later roster work lands.
 */

import fs from "node:fs";
import path from "node:path";

const migrationName = "141-oneroster-core.sql";
const migrationPath = path.join(
  process.cwd(),
  "infra/database/schema",
  migrationName
);
const migration = fs.readFileSync(migrationPath, "utf8");

const tableNames = [
  "oneroster_orgs",
  "oneroster_academic_sessions",
  "oneroster_courses",
  "oneroster_classes",
  "oneroster_class_terms",
  "oneroster_users",
  "oneroster_user_roles",
  "oneroster_enrollments",
] as const;

function tableBody(tableName: (typeof tableNames)[number]): string {
  const match = migration.match(
    new RegExp(
      `CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`
    )
  );

  if (!match?.[1]) {
    throw new Error(`Missing CREATE TABLE for ${tableName}`);
  }

  return match[1].replace(/\s+/g, " ");
}

describe("OneRoster core migration", () => {
  it("creates exactly the eight in-scope roster tables", () => {
    const createdTables = [
      ...migration.matchAll(/CREATE TABLE IF NOT EXISTS (oneroster_\w+)/g),
    ].map((match) => match[1]);

    expect(createdTables).toEqual(tableNames);
    expect(migration).not.toContain("oneroster_demographics");
  });

  it.each(tableNames)(
    "%s has sync bookkeeping and an updated_at trigger",
    (tableName) => {
      const body = tableBody(tableName);

      expect(body).toContain(
        "status text CHECK (status IN ('active', 'tobedeleted'))"
      );
      expect(body).toContain("is_active boolean NOT NULL DEFAULT true");
      expect(body).toContain("date_last_modified timestamptz");
      expect(body).toContain("last_synced_at timestamptz");
      expect(body).toContain(
        "created_at timestamptz NOT NULL DEFAULT now()"
      );
      expect(body).toContain(
        "updated_at timestamptz NOT NULL DEFAULT now()"
      );
      expect(migration).toContain(
        `CREATE TRIGGER update_${tableName}_updated_at`
      );
      expect(migration).toContain(
        `BEFORE UPDATE ON ${tableName}\n  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
      );
    }
  );

  it("uses indexes instead of foreign keys for roster sourced-id references", () => {
    expect(migration).not.toMatch(/\bREFERENCES\s+oneroster_/i);

    const requiredIndexes = [
      "idx_oneroster_orgs_parent_sourced_id",
      "idx_oneroster_academic_sessions_parent_sourced_id",
      "idx_oneroster_courses_org_sourced_id",
      "idx_oneroster_classes_course_sourced_id",
      "idx_oneroster_classes_school_sourced_id",
      "idx_oneroster_class_terms_term_sourced_id",
      "idx_oneroster_user_roles_org_sourced_id",
      "idx_oneroster_enrollments_class_sourced_id",
      "idx_oneroster_enrollments_user_sourced_id",
      "idx_oneroster_enrollments_school_sourced_id",
    ];

    for (const indexName of requiredIndexes) {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    }
  });

  it("enforces entity and relationship uniqueness", () => {
    const sourcedIdTables = [
      "orgs",
      "academic_sessions",
      "courses",
      "classes",
      "users",
      "enrollments",
    ];

    for (const tableName of sourcedIdTables) {
      expect(migration).toContain(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_${tableName}_sourced_id`
      );
    }

    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_class_terms_class_term"
    );
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_user_roles_tuple"
    );
    expect(migration).toContain("coalesce(org_sourced_id, '')");
  });

  it("indexes the lowercase roster email join key", () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_oneroster_users_email\s+ON oneroster_users \(lower\(email\)\);/
    );
  });

  it("contains no executable DO blocks", () => {
    expect(migration).not.toMatch(/^\s*DO\s+\$\$/m);
  });

  it("is registered in the migration manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "infra/database/migrations.json"),
        "utf8"
      )
    ) as { migrationFiles: string[] };

    expect(manifest.migrationFiles).toContain(migrationName);
  });
});
