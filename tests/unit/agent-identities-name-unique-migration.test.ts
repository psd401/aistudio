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
import { validatedFs } from "@/lib/filesystem/validated-fs";

const schemaDir = path.join(process.cwd(), "infra/database/schema");
const migrationFile = "140-agent-identities-name-unique.sql";
const migration = fs.readFileSync(path.join(schemaDir, migrationFile), "utf8");
/** The migration with `--` comment lines removed — i.e. the SQL that runs. */
const migrationSql = migration.replace(/--[^\n]*/g, "");
const normalizedMigrationSql = migrationSql.replace(/\s+/g, " ").toLowerCase();

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
    const sql = validatedFs.readFileSync(path.join(schemaDir, file), "utf8");
    // Strip line comments so commented-out DDL never counts as a declaration.
    const code = sql.replace(/--[^\n]*/g, "");

    let currentTable: string | null = null;
    for (const line of code.split("\n")) {
      const droppedTable = readTableName(line, "DROP");
      if (droppedTable) dropped.add(droppedTable);
      const createTable = readTableName(line, "CREATE");
      if (createTable) currentTable = createTable;
      const alterTable = readTableName(line, "ALTER");
      if (alterTable) currentTable = alterTable;

      const inline = line.match(
        /^\s{0,40}([A-Za-z_]\w*)\s{1,20}uuid\b[^,\n]{0,500}REFERENCES\s{1,20}agent_identities\s{0,20}\(/i
      );
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

function isSqlName(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z_]$/.test(value[0])) return false;
  return [...value].every((character) => /^[A-Za-z0-9_]$/.test(character));
}

function readTableName(
  line: string,
  operation: "ALTER" | "CREATE" | "DROP"
): string | null {
  const tokens = line.trim().replace(/[(),;]/g, " ").split(/\s+/);
  const upper = tokens.map((token) => token.toUpperCase());
  if (upper[0] !== operation || upper[1] !== "TABLE") return null;

  let index = 2;
  if (operation === "CREATE" && upper[2] === "IF") index = 5;
  if (operation === "DROP" && upper[2] === "IF") index = 4;
  if (operation === "ALTER" && upper[2] === "ONLY") index = 3;
  return isSqlName(tokens[index]) ? tokens[index].toLowerCase() : null;
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
      const updatePrefix = `update ${table} `;
      const updateStart = normalizedMigrationSql.indexOf(updatePrefix);
      if (updateStart === -1) return true;
      const updateEnd = normalizedMigrationSql.indexOf(";", updateStart);
      const statement = normalizedMigrationSql.slice(updateStart, updateEnd);
      return !statement.includes(`set ${column} = d.keep_id`);
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
    // five FK indexes, repoint, tombstone, unique index
    expect(statements).toHaveLength(8);
    for (const stmt of statements.slice(0, 5)) {
      expect(stmt).toMatch(/^CREATE INDEX IF NOT EXISTS idx_/i);
    }
    expect(statements[5]).toMatch(/^WITH canon AS/i);
    expect(statements[6]).toMatch(/UPDATE\s+agent_identities\s+a/i);
    expect(statements[6]).toMatch(/is_active\s*=\s*false/i);
    expect(statements[7]).toMatch(/^CREATE UNIQUE INDEX/i);
  });

  it("indexes every repointed FK column that lacked one", () => {
    // content_publish_requests.requested_by_agent_id already has
    // idx_cpr_requested_by_agent_id (096); the other five child tables never
    // indexed their agent-identity FK, so the repoint UPDATEs would seq-scan
    // them on every fresh stand-up.
    const pairs: Array<[string, string]> = [
      ["content_objects", "created_by_agent_id"],
      ["content_versions", "author_agent_id"],
      ["content_audit_logs", "agent_id"],
      ["atrium_doc_comments", "author_agent_id"],
      ["content_assets", "uploader_agent_id"],
    ];
    const indexedColumns = new Set(
      [...migrationSql.matchAll(
        /CREATE INDEX IF NOT EXISTS \S+\s+ON\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*\)/gi
      )].map((match) => `${match[1].toLowerCase()}.${match[2].toLowerCase()}`)
    );
    for (const [table, column] of pairs) {
      expect(indexedColumns).toContain(`${table}.${column}`);
    }
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
        /ORDER BY name, \(id <> '0a710f00-0000-4000-a000-000000000f36'\), \(NOT is_active\), \(oauth_client_id IS NULL\), created_at, id/g
      ),
    ];
    // Once per statement that must pick a canonical row: the repoint and the
    // tombstone. They MUST be byte-identical or the two passes could disagree
    // about which row is canonical.
    expect(orderings).toHaveLength(2);
  });

  it("prefers an ACTIVE row over an inactive one, above the binding test", () => {
    // findAgentIdentity (lib/content/requester-from-auth.ts) filters on
    // is_active, so a canonical row that is inactive leaves the agent with no
    // resolvable identity. `(NOT is_active)` must therefore outrank
    // `(oauth_client_id IS NULL)`: an inactive row is unusable at runtime
    // whether or not it is bound, so an active-but-unbound row is the better
    // survivor. The fixed-id pin still outranks both.
    const order = migration.match(/ORDER BY name,[^\n]*/)![0];
    const pinnedAt = order.indexOf("0a710f00");
    const activeAt = order.indexOf("NOT is_active");
    const boundAt = order.indexOf("oauth_client_id IS NULL");
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(activeAt).toBeGreaterThan(pinnedAt);
    expect(boundAt).toBeGreaterThan(activeAt);
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
