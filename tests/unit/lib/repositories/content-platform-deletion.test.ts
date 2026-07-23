/** @jest-environment node */

import { beforeAll, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mockExecuteQuery = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockToPgRows = jest.fn((result: unknown) => result);

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: mockExecuteQuery,
  executeTransaction: mockExecuteTransaction,
  toPgRows: mockToPgRows,
}));

const NOW = new Date("2026-07-23T12:00:00.000Z");
const dialect = new PgDialect();
let beginRepositoryDeletion: typeof import("@/lib/repositories/content-platform/deletion-service").beginRepositoryDeletion;
let beginRepositoryItemDeletion: typeof import("@/lib/repositories/content-platform/deletion-service").beginRepositoryItemDeletion;
let assertRepositoryProducerActive: typeof import("@/lib/repositories/content-platform/upload-service").assertRepositoryProducerActive;
let isRepositoryProcessingTargetActive: typeof import("@/lib/repositories/content-platform/worker-job-service").isRepositoryProcessingTargetActive;
let isPublicationTargetActive: typeof import("@/lib/repositories/content-platform/publication-service").isPublicationTargetActive;
let defaultNexusRepositoryLifecycleDependencies: typeof import("@/lib/repositories/content-platform/lifecycle-service").defaultNexusRepositoryLifecycleDependencies;

function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

function installTransaction(
  results: unknown[]
): jest.Mock<(query: unknown) => Promise<unknown>> {
  const execute = jest.fn<(query: unknown) => Promise<unknown>>();
  for (const result of results) execute.mockResolvedValueOnce(result);
  mockExecuteTransaction.mockImplementationOnce(
    async (callback: unknown) =>
      (callback as (tx: { execute: typeof execute }) => Promise<unknown>)({
        execute,
      })
  );
  return execute;
}

const activeRepository = {
  id: 7,
  repository_kind: "durable",
  lifecycle_status: "active",
  expires_at: null,
};
const activeItem = {
  id: 11,
  repository_id: 7,
  type: "document",
  source: "repositories/7/source.pdf",
  lifecycle_status: "active",
};

describe("canonical repository deletion producer fence", () => {
  beforeAll(async () => {
    ({ beginRepositoryDeletion, beginRepositoryItemDeletion } = await import(
      "@/lib/repositories/content-platform/deletion-service"
    ));
    ({ assertRepositoryProducerActive } = await import(
      "@/lib/repositories/content-platform/upload-service"
    ));
    ({ isRepositoryProcessingTargetActive } = await import(
      "@/lib/repositories/content-platform/worker-job-service"
    ));
    ({ isPublicationTargetActive } = await import(
      "@/lib/repositories/content-platform/publication-service"
    ));
    ({ defaultNexusRepositoryLifecycleDependencies } = await import(
      "@/lib/repositories/content-platform/lifecycle-service"
    ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("locks repository and items before cancelling work and entering deleting", async () => {
    const execute = installTransaction([
      [activeRepository],
      [activeItem],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    await expect(beginRepositoryDeletion(7, NOW)).resolves.toEqual([
      {
        id: 11,
        repositoryId: 7,
        type: "document",
        source: "repositories/7/source.pdf",
      },
    ]);

    expect(sqlText(execute.mock.calls[0]![0])).toContain(
      "FOR UPDATE OF repository"
    );
    expect(sqlText(execute.mock.calls[1]![0])).toContain("FOR UPDATE OF item");
    expect(sqlText(execute.mock.calls[2]![0])).toContain(
      "repository_upload_sessions"
    );
    expect(sqlText(execute.mock.calls[3]![0])).toContain(
      "job.status = 'running'"
    );
    expect(sqlText(execute.mock.calls[3]![0])).toContain(
      "job.metrics ? 'bdaInvocationArn'"
    );
    expect(sqlText(execute.mock.calls[3]![0])).toContain(
      "job.metrics ->> 'bdaInvocationState'"
    );
    expect(sqlText(execute.mock.calls[3]![0])).toContain("<> 'terminal'");
    expect(sqlText(execute.mock.calls.at(-1)![0])).toContain(
      "lifecycle_status = 'deleting'"
    );
  });

  it("rejects a completed/replayable URL through the post-expiry settle window", async () => {
    const execute = installTransaction([
      [activeRepository],
      [activeItem],
      [{ id: "completed-session" }],
      [],
    ]);

    await expect(beginRepositoryDeletion(7, NOW)).rejects.toMatchObject({
      name: "RepositoryDeletionBlockedError",
      blocker: "unexpired-upload",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    const uploadQuery = dialect.sqlToQuery(execute.mock.calls[2]![0] as SQL);
    expect(uploadQuery.sql).toContain("session.expires_at >");
    expect(uploadQuery.params).toContain("2026-07-23T11:00:00.000Z");
  });

  it("rejects running and deferred managed-service producers without cancelling them", async () => {
    const execute = installTransaction([
      [activeRepository],
      [activeItem],
      [],
      [{ id: "managed-provider-job" }],
    ]);

    await expect(beginRepositoryDeletion(7, NOW)).rejects.toEqual(
      expect.objectContaining({
        blocker: "running-processing-job",
      })
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("keeps a deleting repository reachable as an idempotent cleanup retry", async () => {
    installTransaction([
      [{ ...activeRepository, lifecycle_status: "deleting" }],
      [activeItem],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    await expect(beginRepositoryDeletion(7, NOW)).resolves.toHaveLength(1);
  });

  it("fences one item while its parent remains active", async () => {
    const execute = installTransaction([
      [activeRepository],
      [activeItem],
      [],
      [],
      [],
      [],
      [],
    ]);

    await expect(
      beginRepositoryItemDeletion({ repositoryId: 7, itemId: 11 }, NOW)
    ).resolves.toMatchObject({ id: 11, repositoryId: 7 });
    expect(sqlText(execute.mock.calls[0]![0])).toContain(
      "FOR UPDATE OF repository"
    );
    expect(sqlText(execute.mock.calls[1]![0])).toContain("FOR UPDATE OF item");
  });

  it("makes both upload completion and worker claim reject after deletion wins the lock", () => {
    expect(() =>
      assertRepositoryProducerActive({
        lifecycleStatus: "deleting",
        expiresAt: null,
      })
    ).toThrow("Repository is no longer active");
    expect(
      isRepositoryProcessingTargetActive(
        {
          repositoryLifecycleStatus: "deleting",
          repositoryExpiresAt: null,
          itemLifecycleStatus: "deleting",
          currentVersionId: "version-1",
        },
        "version-1",
        NOW
      )
    ).toBe(false);
    expect(
      isPublicationTargetActive(
        {
          repositoryLifecycleStatus: "deleting",
          repositoryExpiresAt: null,
          itemLifecycleStatus: "deleting",
        },
        NOW
      )
    ).toBe(false);
  });

  it("rechecks scheduled-purge blockers after repository and item locks", async () => {
    const claimedAt = new Date("2026-07-23T12:00:00.000Z");
    const execute = installTransaction([
      [{ id: 7 }],
      [],
      [],
      [],
      [],
      [],
      [],
      [{ id: 7, updated_at: claimedAt }],
    ]);

    await expect(
      defaultNexusRepositoryLifecycleDependencies.claim({
        now: NOW,
        graceEndsBefore: new Date("2026-07-16T12:00:00.000Z"),
        staleLeaseBefore: new Date("2026-07-23T11:40:00.000Z"),
        batchSize: 10,
      })
    ).resolves.toEqual([{ repositoryId: 7, claimedAt }]);

    expect(sqlText(execute.mock.calls[0]![0])).toContain(
      "FOR UPDATE OF repository SKIP LOCKED"
    );
    expect(sqlText(execute.mock.calls[1]![0])).toContain(
      "FOR UPDATE OF item"
    );
    expect(sqlText(execute.mock.calls[2]![0])).toContain(
      "repository_upload_sessions"
    );
    expect(sqlText(execute.mock.calls[3]![0])).toContain(
      "job.metrics ? 'textractJobId'"
    );
    expect(sqlText(execute.mock.calls[3]![0])).toContain(
      "job.metrics ->> 'bdaInvocationState'"
    );
  });

  it("leaves an ephemeral purge unclaimed when a completed URL is still settling", async () => {
    const execute = installTransaction([
      [{ id: 7 }],
      [],
      [{ repository_id: 7, id: "completed-session" }],
      [],
    ]);

    await expect(
      defaultNexusRepositoryLifecycleDependencies.claim({
        now: NOW,
        graceEndsBefore: new Date("2026-07-16T12:00:00.000Z"),
        staleLeaseBefore: new Date("2026-07-23T11:40:00.000Z"),
        batchSize: 10,
      })
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(4);
    const uploadQuery = dialect.sqlToQuery(execute.mock.calls[2]![0] as SQL);
    expect(uploadQuery.params).toContain("2026-07-23T11:00:00.000Z");
  });
});
