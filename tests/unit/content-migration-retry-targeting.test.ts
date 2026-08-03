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
const migrationControlPanel = readFileSync(
  resolve(
    process.cwd(),
    "app/(protected)/admin/repositories/_components/migration-control-panel.tsx",
  ),
  "utf8",
);
const migrationReasonDialog = readFileSync(
  resolve(
    process.cwd(),
    "app/(protected)/admin/repositories/_components/migration-exception-reason-dialog.tsx",
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

  it("allows targeted retries to re-register an existing canonical version", () => {
    const repositoryCandidateStart = migrationRunner.indexOf(
      "async function loadNextRepositoryCandidate",
    );
    const repositoryCandidateEnd = migrationRunner.indexOf(
      "async function loadNextCandidate",
      repositoryCandidateStart,
    );
    const repositoryCandidate = migrationRunner.slice(
      repositoryCandidateStart,
      repositoryCandidateEnd,
    );

    expect(repositoryCandidate).toMatch(
      /\$\{discoverUntrackedSources\} = FALSE[\s\S]*?item\.current_version_id IS NULL/,
    );
    expect(repositoryCandidate).toContain(
      "migration.run_id = ${run.id}::uuid",
    );
    expect(migrationRunner).toContain(
      "await registerExistingCanonicalVersion(candidate, reserved, targetKey)",
    );
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

  it("treats audited exclusions as accounted-for migration inventory", () => {
    expect(
      migrationControlService.match(
        /migration\.status IN \('verified', 'excluded'\)/g,
      ),
    ).toHaveLength(3);
    expect(migrationControlService).toContain(
      "export async function excludeRepositoryMigrationException",
    );
    expect(migrationControlService).toContain(
      'contentMigration.excludeException',
    );
  });

  it("records rollback-drill audit evidence in the initial run insert", () => {
    const functionStart = migrationControlService.indexOf(
      "export async function runRepositoryMigrationRollbackDrill",
    );
    const functionEnd = migrationControlService.indexOf(
      "function migrationMetricsFromRows",
      functionStart,
    );
    const rollbackDrill = migrationControlService.slice(
      functionStart,
      functionEnd,
    );

    expect(rollbackDrill).toContain("rollbackDrill: true");
    expect(rollbackDrill).toContain("migrationItemId: sample.migration_id");
    expect(rollbackDrill).toContain("canonicalItemId: sample.item_id");
    expect(rollbackDrill).not.toContain("UPDATE repository_migration_runs");
  });

  it("collects audit reasons in an accessible application dialog", () => {
    expect(migrationControlPanel).not.toContain("window.prompt");
    expect(migrationControlPanel).toContain("MigrationExceptionReasonDialog");
    expect(migrationReasonDialog).toContain("<DialogTitle>");
    expect(migrationReasonDialog).toContain(
      'Label htmlFor="migration-exception-reason"',
    );
    expect(migrationReasonDialog).toContain("minLength={10}");
    expect(migrationReasonDialog).toContain("maxLength={1000}");
  });

  it("turns migrated rows without canonical versions into retryable exceptions", () => {
    const functionStart = migrationRunner.indexOf(
      "async function reconcileMigrationCandidate",
    );
    const functionEnd = migrationRunner.indexOf(
      "async function finishPreviouslyPreparedRollback",
      functionStart,
    );
    const reconciliation = migrationRunner.slice(functionStart, functionEnd);

    expect(reconciliation).toContain(
      'lastErrorCode: "MIGRATION_CANONICAL_VERSION_MISSING"',
    );
    expect(reconciliation).toContain('status: "unrecoverable"');
    expect(reconciliation).toContain('return "unrecoverable"');
    expect(reconciliation).not.toContain("canonical_version_id IS NOT NULL");
    expect(reconciliation).not.toContain(
      "repositoryMigrationItems.canonicalVersionId} IS NOT NULL",
    );
  });
});
