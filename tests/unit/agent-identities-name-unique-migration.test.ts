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
 *   1. the migration repoints EVERY live FK column before deleting duplicates
 *      (a missed column would abort the deploy on an FK violation, or — worse
 *      with ON DELETE SET NULL — silently drop agent attribution), and
 *   2. the seed script upserts on `name` rather than read-then-insert.
 */

import fs from "node:fs";
import path from "node:path";

const schemaDir = path.join(process.cwd(), "infra/database/schema");
const migrationFile = "140-agent-identities-name-unique.sql";
const migration = fs.readFileSync(path.join(schemaDir, migrationFile), "utf8");

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

  it("repoints every live FK column onto the canonical row before deleting duplicates", () => {
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

  it("repoints and deletes in ONE statement so a live writer cannot lose attribution", () => {
    // The migration runner issues each statement as its own RDS Data API call
    // with no way to span a transaction. Split across statements, a request
    // could insert a child row referencing a duplicate AFTER that table's
    // repoint committed; every one of these FKs is ON DELETE SET NULL, so the
    // delete would then silently erase the new row's agent attribution.
    // Everything therefore rides in a single data-modifying-CTE statement.
    const statements = migration
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2); // the dedupe, then the index

    const dedupe = statements[0];
    expect(dedupe).toMatch(/^WITH canon AS/i);
    expect(dedupe).toMatch(/DELETE\s+FROM\s+agent_identities\s+a\s+USING\s+dupes\s+d\s+WHERE\s+a\.id\s*=\s*d\.dup_id/i);
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX/i);
  });

  it("locks the duplicate rows so concurrent FK writers block instead of losing rows", () => {
    // Inserting a child row takes FOR KEY SHARE on the parent, which conflicts
    // with FOR UPDATE — so a writer that would have raced the delete blocks
    // and then fails loudly on an FK violation. MATERIALIZED is load-bearing:
    // without it the CTE may be inlined into each dependent CTE rather than
    // evaluated once up front, so the lock is not reliably taken first.
    expect(migration).toMatch(/dupes AS MATERIALIZED \(/);
    expect(migration).toMatch(/FOR UPDATE OF a/);
  });

  it("states the canonical-row rule exactly once", () => {
    const orderings = [
      ...migration.matchAll(
        /ORDER BY name, \(id <> '0a710f00-0000-4000-a000-000000000f36'\), \(oauth_client_id IS NULL\), created_at, id/g
      ),
    ];
    expect(orderings).toHaveLength(1);
  });

  it("never deletes an agent identity id that application code pins", () => {
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
    expect(rules).toHaveLength(1);
    expect(rules[0][1]).toBe(id);
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
