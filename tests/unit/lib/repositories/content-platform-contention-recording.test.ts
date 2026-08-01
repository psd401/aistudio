/** @jest-environment node */

import { beforeAll, jest } from "@jest/globals";
import { repositoryProcessingJobs } from "@/lib/db/schema";

const mockExecuteTransaction = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: mockExecuteTransaction,
  toPgRows: (result: unknown) => result,
}));

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const VERSION_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const decision = {
  terminal: false,
  code: "REPOSITORY_PUBLICATION_CONTENTION",
  message: "lock wait expired",
  refundAttempt: true,
} as const;

let recordRepositoryProcessingFailure: typeof import("@/lib/repositories/content-platform/worker-job-service").recordRepositoryProcessingFailure;
let maxContentionRefunds: number;

function createJobOnlyTransaction(contentionRefunds: number) {
  const forUpdate = jest.fn(async () => [
    {
      id: JOB_ID,
      itemVersionId: VERSION_ID,
      status: "running",
      attempt: 5,
      maxAttempts: 5,
      metrics: { provider: "unified-content", contentionRefunds },
    },
  ]);
  const limit = jest.fn(() => ({ for: forUpdate }));
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const updateWhere = jest.fn(async () => []);
  const set = jest.fn((values: Record<string, unknown>) => ({
    values,
    where: updateWhere,
  }));
  const update = jest.fn(() => ({ set }));
  return {
    transaction: { select, update },
    spies: { forUpdate, from, select, set, update, updateWhere },
  };
}

beforeAll(async () => {
  const workerJobService = await import(
    "@/lib/repositories/content-platform/worker-job-service"
  );
  recordRepositoryProcessingFailure =
    workerJobService.recordRepositoryProcessingFailure;
  maxContentionRefunds =
    workerJobService.MAX_REPOSITORY_PUBLICATION_CONTENTION_REFUNDS;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteTransaction.mockReset();
});

describe("repository publication contention recording", () => {
  it("persists a final-attempt refund without acquiring the repository lock", async () => {
    const { transaction, spies } = createJobOnlyTransaction(3);
    mockExecuteTransaction.mockImplementationOnce(
      async (callback: unknown) =>
        (callback as (tx: typeof transaction) => Promise<unknown>)(transaction)
    );

    await expect(
      recordRepositoryProcessingFailure(
        { jobId: JOB_ID, itemVersionId: VERSION_ID },
        decision,
        { now: NOW, retryDelaySeconds: () => 7 }
      )
    ).resolves.toEqual({ action: "retry", delaySeconds: 7 });

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(spies.from).toHaveBeenCalledWith(repositoryProcessingJobs);
    expect(spies.forUpdate).toHaveBeenCalledWith("update");
    expect(spies.update).toHaveBeenCalledWith(repositoryProcessingJobs);
    expect(spies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        attempt: 4,
        leaseOwner: null,
        leaseExpiresAt: null,
        metrics: { provider: "unified-content", contentionRefunds: 4 },
      })
    );
  });

  it("falls back to the normal failure budget once the refund cap is reached", async () => {
    const { transaction } = createJobOnlyTransaction(maxContentionRefunds);
    mockExecuteTransaction
      .mockImplementationOnce(
        async (callback: unknown) =>
          (callback as (tx: typeof transaction) => Promise<unknown>)(transaction)
      )
      .mockImplementationOnce(async () => ({
        action: "terminal",
        code: "RETRY_BUDGET_EXHAUSTED",
      }));

    await expect(
      recordRepositoryProcessingFailure(
        { jobId: JOB_ID, itemVersionId: VERSION_ID },
        decision,
        { now: NOW, retryDelaySeconds: () => 7 }
      )
    ).resolves.toEqual({
      action: "terminal",
      code: "RETRY_BUDGET_EXHAUSTED",
    });
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(2);
  });
});
