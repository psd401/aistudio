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
  collectSupersededRepositoryGenerations,
  GENERATION_GC_CHUNK_BATCH,
  GENERATION_GC_GENERATION_BATCH,
  GENERATION_GC_PER_REPOSITORY_BATCH,
  GENERATION_GC_REPOSITORY_BATCH,
  SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY,
  SUPERSEDED_GENERATION_RETENTION_HOURS,
} from "@/lib/repositories/content-platform/generation-retention";

const mockExecuteTransaction = executeTransaction as jest.MockedFunction<
  typeof executeTransaction
>;

describe("superseded repository generation retention", () => {
  beforeEach(() => {
    mockExecuteTransaction.mockReset();
  });

  it("compiles bounded deletion with every active-generation safety guard", async () => {
    const queries: SQL[] = [];
    const execute = jest
      .fn<(query: SQL) => Promise<Array<{ deleted_count: number }>>>(
        async (query) => {
          queries.push(query);
          return [];
        },
      )
      .mockImplementationOnce(async (query) => {
        queries.push(query);
        return [{ deleted_count: 20_000 }];
      })
      .mockImplementationOnce(async (query) => {
        queries.push(query);
        return [{ deleted_count: 17 }];
      });

    mockExecuteTransaction.mockImplementationOnce(async (callback) =>
      callback({ execute } as never),
    );

    const now = new Date("2026-08-01T12:00:00.000Z");
    const repositoryBatchSize = 37;
    const repositoryProbeAnchor = (
      BigInt(Math.floor(now.getTime() / 60_000)) *
      BigInt(repositoryBatchSize)
    ).toString();
    await expect(
      collectSupersededRepositoryGenerations({ now, repositoryBatchSize }),
    ).resolves.toEqual({
      chunksDeleted: 20_000,
      generationsDeleted: 17,
    });

    expect(queries).toHaveLength(2);
    const [chunkDeletion, generationDeletion] = queries.map((query) =>
      new PgDialect().sqlToQuery(query),
    );
    expect(chunkDeletion).toBeDefined();
    expect(generationDeletion).toBeDefined();

    for (const compiled of [chunkDeletion!, generationDeletion!]) {
      expect(compiled.sql).toContain("kept_generation.status = 'superseded'");
      expect(compiled.sql).toContain(
        "candidate_generation.status = 'superseded'",
      );
      expect(compiled.sql).not.toContain("row_number() OVER");
      expect(compiled.sql).toContain("repository_probe_ids AS MATERIALIZED");
      expect(compiled.sql).toContain(
        "WHERE repository.id >= probe_start.id",
      );
      expect(compiled.sql).toContain(
        "WHERE repository.id < probe_start.id",
      );
      expect(compiled.sql).toContain("FROM repository_probe_ids probe");
      expect(compiled.sql).toContain("CROSS JOIN LATERAL");
      expect(compiled.sql).toContain(
        "kept_generation.repository_id = repository.id",
      );
      expect(compiled.sql).toContain(
        "ORDER BY kept_generation.superseded_at DESC,",
      );
      expect(compiled.sql).toContain("kept_generation.created_at DESC");
      expect(compiled.sql).toContain("OFFSET");
      expect(compiled.sql).toContain(
        "candidate_generation.created_at,",
      );
      expect(compiled.sql).toContain("keep_floor.created_at, keep_floor.id");
      expect(compiled.sql).toContain(
        "ORDER BY oldest_candidate.superseded_at",
      );
      expect(compiled.sql).toContain("candidate_generation.superseded_at <");
      expect(compiled.sql).not.toContain("generation.created_at <");
      expect(compiled.sql).toContain(
        "candidate_generation.id IS DISTINCT FROM repository.active_index_generation_id",
      );
      expect(compiled.sql).toContain(
        "active_repository.active_index_generation_id = candidate_generation.id",
      );
      expect(compiled.sql).toContain(
        "FOR UPDATE OF repository SKIP LOCKED",
      );
      expect(compiled.sql).toContain(
        "FOR UPDATE OF candidate_generation SKIP LOCKED",
      );
      expect(compiled.params).toContain("2026-07-31T12:00:00.000Z");
      expect(compiled.params).toContain(
        SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY - 1,
      );
      expect(compiled.params).toContain(repositoryProbeAnchor);
      expect(compiled.params).toContain(repositoryBatchSize);
      expect(compiled.params).toContain(GENERATION_GC_GENERATION_BATCH);
      expect(compiled.params).toContain(GENERATION_GC_PER_REPOSITORY_BATCH);
      expect(compiled.sql).not.toMatch(
        /generation\.status\s+(?:=|IN)\s*\(?\s*'(?:active|building)'/i,
      );
    }

    expect(chunkDeletion!.sql).toContain("chunk.ctid AS row_id");
    expect(chunkDeletion!.sql).toContain("chunk.ctid = selected.row_id");
    expect(chunkDeletion!.sql).not.toContain("ORDER BY chunk.id");
    expect(chunkDeletion!.params).toContain(GENERATION_GC_CHUNK_BATCH);
    expect(generationDeletion!.sql).toContain(
      "remaining_chunk.index_generation_id = generation.id",
    );
    expect(SUPERSEDED_GENERATION_RETENTION_HOURS).toBe(24);
    expect(SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY).toBe(3);
    expect(GENERATION_GC_CHUNK_BATCH).toBe(20_000);
    expect(GENERATION_GC_REPOSITORY_BATCH).toBe(200);
    expect(GENERATION_GC_GENERATION_BATCH).toBe(200);
    expect(GENERATION_GC_PER_REPOSITORY_BATCH).toBe(10);
  });

  it.each([
    ["retentionHours", { retentionHours: 0 }],
    ["keepPerRepository", { keepPerRepository: 0 }],
    ["chunkBatchSize", { chunkBatchSize: 0 }],
    ["repositoryBatchSize", { repositoryBatchSize: 0 }],
    ["generationBatchSize", { generationBatchSize: 0 }],
    [
      "perRepositoryGenerationBatchSize",
      { perRepositoryGenerationBatchSize: 0 },
    ],
  ])("rejects an unsafe %s override", async (name, options) => {
    await expect(
      collectSupersededRepositoryGenerations(options),
    ).rejects.toThrow(`${name} must be a positive integer`);
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });
});
