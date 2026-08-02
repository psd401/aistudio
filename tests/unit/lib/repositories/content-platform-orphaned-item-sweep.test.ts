/** @jest-environment node */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: jest.fn(),
  toPgRows: (rows: unknown) => rows,
}));

import { executeTransaction } from "@/lib/db/drizzle-client";
import {
  failOrphanedRepositoryItems,
  ORPHANED_ITEM_FAILURE_MESSAGE,
  ORPHANED_ITEM_SWEEP_BATCH,
  ORPHANED_ITEM_SWEEP_MINUTES,
} from "@/lib/repositories/content-platform/orphaned-item-sweep";
import { isRetryableLegacyItemFailure } from "@/lib/repositories/content-platform/status-service";

const mockExecuteTransaction = executeTransaction as jest.MockedFunction<
  typeof executeTransaction
>;

describe("orphaned repository item sweep", () => {
  beforeEach(() => {
    mockExecuteTransaction.mockReset();
  });

  it("atomically fails one bounded batch of active, job-less items", async () => {
    let capturedQuery: SQL | undefined;
    const execute = jest.fn<(query: SQL) => Promise<unknown>>(async (query) => {
      capturedQuery = query;
      return [{ id: 34 }, { id: 35 }];
    });
    mockExecuteTransaction.mockImplementationOnce(async (callback) =>
      callback({ execute } as never),
    );

    await expect(
      failOrphanedRepositoryItems({
        now: new Date("2026-08-01T12:00:00.000Z"),
        minimumAgeMinutes: 17,
        batchSize: 23,
      }),
    ).resolves.toEqual({ failed: 2 });

    expect(capturedQuery).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(capturedQuery as SQL);
    expect(compiled.sql).toContain("candidate.current_version_id IS NULL");
    expect(compiled.sql).toContain("candidate.lifecycle_status = 'active'");
    expect(compiled.sql).toContain("repository.lifecycle_status = 'active'");
    expect(compiled.sql).toContain("candidate.processing_status IN");
    expect(compiled.sql).toContain("NOT EXISTS");
    expect(compiled.sql).toContain("FROM repository_item_versions version");
    expect(compiled.sql).toContain("INNER JOIN repository_processing_jobs job");
    expect(compiled.sql).toContain("version.item_id = candidate.id");
    expect(compiled.sql).toContain("FOR UPDATE OF candidate SKIP LOCKED");
    expect(compiled.sql).toContain("LIMIT");
    expect(compiled.params).toContain("2026-08-01T11:43:00.000Z");
    expect(compiled.params).toContain(23);
    expect(compiled.params).toContain(ORPHANED_ITEM_FAILURE_MESSAGE);
  });

  it("uses the locked production bounds and produces a retryable failure", () => {
    expect(ORPHANED_ITEM_SWEEP_MINUTES).toBe(60);
    expect(ORPHANED_ITEM_SWEEP_BATCH).toBe(100);
    expect(
      isRetryableLegacyItemFailure("failed", ORPHANED_ITEM_FAILURE_MESSAGE),
    ).toBe(true);
  });
});
