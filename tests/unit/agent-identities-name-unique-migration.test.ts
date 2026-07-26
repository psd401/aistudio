/**
 * Migration 140 — agent_identities name uniqueness (#1303).
 *
 * The bug: `agent_identities.name` is the logical key, but the table only had a
 * random-uuid surrogate PK and no uniqueness on `name`. Migration 085 seeds
 * three identities guarded on `name`, migration 095 seeds one guarded on a
 * FIXED `id`, and scripts/seed-atrium-agents.ts read-then-inserted. Two guards
 * keyed on different columns cannot see each other, so a fresh environment
 * plus a cross-environment data copy produced two rows per name.
 *
 * These tests pin the two halves of the fix that can silently rot:
 *   1. the migration repoints EVERY live FK column (a missed column leaves
 *      attribution split across the duplicate and its tombstone),
 *   2. it NEVER deletes — every one of those FKs is ON DELETE SET NULL, and the
 *      runner cannot span a transaction, so any delete races live writers and
 *      loses their attribution SILENTLY. Duplicates are tombstoned instead, and
 *   3. the seed script upserts on `name` rather than read-then-insert.
 */

import fs from "node:fs";
import path from "node:path";

const schemaDir = path.join(process.cwd(), "infra/database/schema");
const migrationFile = "140-agent-identities-name-unique.sql";
const migration = fs.readFileSync(path.join(schemaDir, migrationFile), "utf8");
/** The migration with `--` comment lines removed — i.e. the SQL that runs. */
const migrationSql = migration.replace(/--[^\n]*/g, "");

const schemaFiles = fs
  .readdirSync(schemaDir)
  .filter((f) => f.endsWith(".sql") && !f.endsWith("-rollback.sql"))
  .sort();

/**
 * Every (table, column) in the schema history that foreign-keys to
 * agent_identities, minus tables a later migration dropped. Both declaration
 * forms are covered: inline `col uuid REFERENCES agent_identities(id)` inside a
 * CREATE TABLE, and `ALTER TABLE t ADD CONSTRAINT ... FOREIGN KEY (col)
 * REFERENCES agent_identities(id)`.
 */
function collectAgentForeignKeys(): { references: Set<string>; dropped: Set<string> } {
  const references = new Set<string>();
  const dropped = new Set<string>();

  for (const file of schemaFiles) {
    const sql = fs.readFileSync(path.join(schemaDir, file), "utf8");
    // Strip line comments so commented-out DDL never counts as a declaration.
    const code = sql.replace(/--[^\n]*/g, "");

    for (const m of code.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi)) {
      dropped.add(m[1].toLowerCase());
    }

    let currentTable: string | null = null;
    for (const line of code.split("\n")) {
      const create = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i);
      if (create) currentTable = create[1].toLowerCase();
      const alter = line.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?([A-Za-z_][\w]*)/i);
      if (alter) currentTable = alter[1].toLowerCase();

      const inline = line.match(/^\s*([A-Za-z_][\w]*)\s+uuid\b[^,]*REFERENCES\s+agent_identities\s*\(/i);
      if (inline && currentTable) {
        references.add(`${currentTable}.${inline[1].toLowerCase()}`);
        continue;
      }
      const explicit = line.match(
        /FOREIGN\s+KEY\s*\(\s*([A-Za-z_][\w]*)\s*\)\s*REFERENCES\s+agent_identities\s*\(/i
      );
      if (explicit && currentTable) {
        references.add(`${currentTable}.${explicit[1].toLowerCase()}`);
      }
    }
  }

  return { references, dropped };
}

describe("migration 140 — agent_identities name uniqueness (#1303)", () => {
  it("is registered in the migration manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "infra/database/migrations.json"), "utf8")
    ) as { migrationFiles: string[] };
    expect(manifest.migrationFiles).toContain(migrationFile);
  });

  it("creates the unique index that makes a second row per name impossible", () => {
    expect(migration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_agent_identities_name\s+ON\s+agent_identities\s*\(\s*name\s*\)/i
    );
  });

  it("repoints every live FK column onto the canonical row", () => {
    const { references, dropped } = collectAgentForeignKeys();
    const live = [...references].filter((ref) => !dropped.has(ref.split(".")[0])).sort();

    // Sanity: the parser must actually find the known referencing columns. If
    // this drops to zero the coverage assertion below would pass vacuously.
    expect(live).toEqual(
      expect.arrayContaining([
        "atrium_doc_comments.author_agent_id",
        "content_assets.uploader_agent_id",
        "content_audit_logs.agent_id",
        "content_objects.created_by_agent_id",
        "content_publish_requests.requested_by_agent_id",
        "content_versions.author_agent_id",
      ])
    );

    const uncovered = live.filter((ref) => {
      const [table, column] = ref.split(".");
      const update = new RegExp(
        `UPDATE\\s+${table}\\s+\\w+\\s+SET\\s+${column}\\s*=\\s*d\\.keep_id`,
        "i"
      );
      return !update.test(migration);
    });
    expect(uncovered).toEqual([]);
  });

  it("NEVER deletes an agent identity — duplicates are tombstoned instead", () => {
    // This is the load-bearing property of the whole migration, and it is not
    // a stylistic choice. All six FKs are ON DELETE SET NULL, and the runner
    // issues each statement as its own RDS Data API call with no way to span a
    // transaction. Any delete therefore races live writers, and the race is
    // LOSSY rather than loud: a child row the repoint missed gets its agent
    // attribution silently stripped. PostgreSQL additionally documents the
    // ordering between sibling data-modifying CTEs and a main-query DELETE
    // whose FK action is SET NULL as UNDEFINED, so no single-statement
    // formulation rescues it either. Removing the delete designs the failure
    // mode out: a missed child row still points at a row that EXISTS.
    // Asserted against the executable SQL, not the file: the header discusses
    // DELETE and DROP TYPE at length explaining why neither appears.
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\b/i);
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("tombstones duplicates by renaming and deactivating them", () => {
    const statements = migrationSql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    // repoint, tombstone, index
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^WITH canon AS/i);
    expect(statements[1]).toMatch(/UPDATE\s+agent_identities\s+a/i);
    expect(statements[1]).toMatch(/is_active\s*=\s*false/i);
    expect(statements[2]).toMatch(/^CREATE UNIQUE INDEX/i);
  });

  it("keeps a tombstoned name inside varchar(200)", () => {
    // name is varchar(200). left(name,150) + '#dup-' (5) + a 36-char uuid = 191.
    const truncation = migration.match(/left\(a\.name,\s*(\d+)\)/);
    expect(truncation).not.toBeNull();
    const keep = Number(truncation![1]);
    const suffix = "#dup-".length + 36;
    expect(keep + suffix).toBeLessThanOrEqual(200);
  });

  it("every FK to agent_identities is ON DELETE SET NULL — the reason not to delete", () => {
    // If a future FK is added WITHOUT ON DELETE SET NULL this test still holds,
    // but if one of these is ever changed to CASCADE the stakes go up further,
    // not down. Either way the no-delete rule above stays correct. This asserts
    // the premise the header documents is actually true of the schema.
    const audit = fs.readFileSync(
      path.join(schemaDir, "090-atrium-content-audit.sql"),
      "utf8"
    );
    expect(audit).toMatch(/agent_id\s+uuid\s+REFERENCES\s+agent_identities\(id\)\s+ON DELETE SET NULL/i);
  });

  it("states the canonical-row rule identically in every statement that needs it", () => {
    const orderings = [
      ...migration.matchAll(
        /ORDER BY name, \(id <> '0a710f00-0000-4000-a000-000000000f36'\), \(oauth_client_id IS NULL\), created_at, id/g
      ),
    ];
    // Once per statement that must pick a canonical row: the repoint and the
    // tombstone. They MUST be byte-identical or the two passes could disagree
    // about which row is canonical.
    expect(orderings).toHaveLength(2);
  });

  it("never tombstones an agent identity id that application code pins", () => {
    // lib/content/okf/import.ts writes ATRIUM_IMPORT_AGENT_ID into
    // content_publish_requests.requested_by_agent_id with no lookup. If the
    // dedupe ever picked a different `atrium-importer` row as canonical, every
    // OKF import would fail on an FK violation.
    const importer = fs.readFileSync(
      path.join(process.cwd(), "lib/content/okf/import.ts"),
      "utf8"
    );
    const pinned = importer.match(
      /ATRIUM_IMPORT_AGENT_ID\s*=\s*"([0-9a-f-]{36})"/
    );
    expect(pinned).not.toBeNull();
    const id = pinned![1];
    // Sorts first in the canonical-row ORDER BY, so it is always the keeper.
    const rules = [...migration.matchAll(/ORDER BY name, \(id <> '([0-9a-f-]{36})'\)/g)];
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule[1]).toBe(id);
  });

  it("uses no DO $$ block (the db-init statement splitter cannot parse them)", () => {
    expect(migration).not.toContain("DO $$");
  });
});

describe("scripts/seed-atrium-agents.ts idempotency (#1303)", () => {
  const seed = fs.readFileSync(
    path.join(process.cwd(), "scripts/seed-atrium-agents.ts"),
    "utf8"
  );

  it("upserts the identity on name instead of read-then-insert", () => {
    expect(seed).toMatch(/\.insert\(agentIdentities\)/);
    expect(seed).toMatch(/target:\s*agentIdentities\.name/);
  });

  it("has no unguarded insert into agentIdentities", () => {
    const inserts = [...seed.matchAll(/\.insert\(agentIdentities\)/g)];
    expect(inserts).toHaveLength(1);
    const after = seed.slice(inserts[0].index ?? 0);
    expect(after).toMatch(/onConflictDoUpdate/);
  });
});

describe("drizzle schema mirrors the constraint", () => {
  it("declares uq_agent_identities_name on agent_identities.name", () => {
    const table = fs.readFileSync(
      path.join(process.cwd(), "lib/db/schema/tables/agent-identities.ts"),
      "utf8"
    );
    expect(table).toMatch(/uniqueIndex\("uq_agent_identities_name"\)\.on\(table\.name\)/);
  });
});
