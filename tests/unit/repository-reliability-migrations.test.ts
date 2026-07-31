import fs from "node:fs";
import path from "node:path";

const schemaDirectory = path.join(process.cwd(), "infra/database/schema");
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "infra/database/migrations.json"),
    "utf8"
  )
) as { migrationFiles: string[] };

function migration(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Names are fixed test fixtures from this file, resolved under the schema directory.
  return fs.readFileSync(path.join(schemaDirectory, name), "utf8");
}

describe("repository reliability migrations", () => {
  it("orders agentic admission and Nexus bindings after cancellation support", () => {
    expect(manifest.migrationFiles.slice(-3)).toEqual([
      "168-repository-item-cancelled-status.sql",
      "169-agentic-model-readiness.sql",
      "170-nexus-durable-repository-bindings.sql",
    ]);
  });

  it("adds explicit fail-closed agentic admission fields", () => {
    const sql = migration("169-agentic-model-readiness.sql");
    expect(sql).toContain("context_window_tokens INTEGER");
    expect(sql).toContain("max_output_tokens INTEGER");
    expect(sql).toContain("agentic_ready BOOLEAN NOT NULL DEFAULT FALSE");
    expect(sql).toContain("ai_models_agentic_ready_check");
    expect(sql).not.toMatch(
      /SET\s+(?:context_window_tokens|max_output_tokens)\s*=\s*max_tokens/i
    );
  });

  it("keeps Nexus binding DDL compatible with the line-oriented migration runner", () => {
    const sql = migration("170-nexus-durable-repository-bindings.sql");
    expect(sql).not.toContain("DO $$");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS nexus_conversation_repositories"
    );
    expect(sql).toContain(
      "CHECK (source IN ('direct', 'project', 'skill', 'assistant'))"
    );
    expect(sql).toContain(
      "UNIQUE (conversation_id, repository_id, source, source_id)"
    );
    expect(sql).not.toContain("updated_at");
  });
});
