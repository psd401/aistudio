/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mockExecuteQuery = jest.fn();
const mockToPgRows = jest.fn((result: unknown) => result);

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: mockExecuteQuery,
  executeTransaction: jest.fn(),
  toPgRows: mockToPgRows,
}));

let getRepositoryMigrationRunMetrics: typeof import("@/lib/repositories/content-platform/migration-runner").getRepositoryMigrationRunMetrics;

describe("repository migration run metrics", () => {
  beforeAll(async () => {
    ({ getRepositoryMigrationRunMetrics } = await import(
      "@/lib/repositories/content-platform/migration-runner"
    ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("attributes retried items to the run that currently owns them", async () => {
    const runId = "738a9787-27e9-40a4-815d-cf34e4311812";
    let capturedQuery: SQL | undefined;
    mockExecuteQuery.mockImplementationOnce(
      async (...args: unknown[]) => {
        const [callback, context] = args;
        expect(context).toBe("contentMigration.runMetrics");
        return (
          callback as (db: {
            execute(query: SQL): Promise<unknown>;
          }) => Promise<unknown>
        )({
          execute: async (query) => {
            capturedQuery = query;
            return [
              { status: "migrated", count: 1 },
              { status: "unrecoverable", count: 2 },
              { status: "excluded", count: 3 },
            ];
          },
        });
      },
    );

    await expect(getRepositoryMigrationRunMetrics(runId)).resolves.toEqual({
      discovered: 3,
      migrated: 1,
      verified: 0,
      mismatched: 0,
      failed: 0,
      unrecoverable: 2,
      excluded: 3,
      rolledBack: 0,
    });
    expect(capturedQuery).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(capturedQuery!);
    expect(compiled.sql).toContain("WHERE run_id = $1::uuid");
    expect(compiled.sql).not.toContain("origin_run_id");
    expect(compiled.params).toEqual([runId]);
  });
});
