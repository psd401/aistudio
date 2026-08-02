/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "@jest/globals";

const migrationRunSchema = readFileSync(
  resolve(
    process.cwd(),
    "lib/db/schema/tables/repository-migration-runs.ts",
  ),
  "utf8",
);
const migrationControlService = readFileSync(
  resolve(
    process.cwd(),
    "lib/repositories/content-platform/migration-control-service.ts",
  ),
  "utf8",
);
const migrationRunner = readFileSync(
  resolve(
    process.cwd(),
    "lib/repositories/content-platform/migration-runner.ts",
  ),
  "utf8",
);

describe("repository migration retry targeting", () => {
  it("marks both single and bounded bulk retry runs as retry-only", () => {
    expect(migrationRunSchema).toContain("retryOnly?: boolean;");
    expect(migrationControlService.match(/retryOnly: true/g)).toHaveLength(2);
  });

  it("requires a current-run migration row for every retry-only source kind", () => {
    expect(
      migrationRunner.match(/\$\{discoverUntrackedSources\} = TRUE/g),
    ).toHaveLength(3);

    for (const assignmentPredicate of [
      /migration\.source_kind = 'repository_item'[\s\S]*?migration\.run_id = \$\{run\.id\}::uuid/,
      /migration\.source_kind = 'nexus_document'[\s\S]*?migration\.run_id = \$\{run\.id\}::uuid/,
      /migration\.source_kind = 'assistant_pdf_job'[\s\S]*?migration\.run_id = \$\{run\.id\}::uuid/,
    ]) {
      expect(migrationRunner).toMatch(assignmentPredicate);
    }
  });

  it("keeps sparse retry selection exact instead of admitting in-range sources", () => {
    const selectedRetryIds = new Set([2, 1_000_000]);
    const sourceIdsInRange = [2, 3, 4, 500_000, 1_000_000];

    const retryOnlyIds = sourceIdsInRange.filter((sourceId) =>
      selectedRetryIds.has(sourceId),
    );

    expect(retryOnlyIds).toEqual([2, 1_000_000]);
    expect(retryOnlyIds).toHaveLength(selectedRetryIds.size);
  });

  it("applies an exception-status filter before the bounded query limit", () => {
    const functionStart = migrationControlService.indexOf(
      "export async function listRepositoryMigrationExceptions",
    );
    const statusFilter = migrationControlService.indexOf(
      ".where(inArray(repositoryMigrationItems.status, statuses))",
      functionStart,
    );
    const limit = migrationControlService.indexOf(
      ".limit(safeLimit)",
      functionStart,
    );

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(migrationControlService).toContain(
      "status?: RepositoryMigrationExceptionStatus",
    );
    expect(statusFilter).toBeGreaterThan(functionStart);
    expect(limit).toBeGreaterThan(statusFilter);
  });
});
