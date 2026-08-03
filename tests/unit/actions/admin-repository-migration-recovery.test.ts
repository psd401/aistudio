/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { CanonicalRepositoryItemStatus } from "@/lib/repositories/content-platform/status-service";

type AsyncMock = (...args: unknown[]) => Promise<unknown>;

const mockGetServerSession = jest.fn<AsyncMock>();
const mockGetUserIdFromSession = jest.fn<AsyncMock>();
const mockHasRole = jest.fn<AsyncMock>();
const mockRetryFailedRepositoryMigrationItems = jest.fn<AsyncMock>();
const mockExcludeRepositoryMigrationException = jest.fn<AsyncMock>();
const mockListRepositoryMigrationExceptions = jest.fn<AsyncMock>();
const mockReprocessRepositoryMigrationItem = jest.fn<AsyncMock>();
const mockAssertNotSystemManagedRepository = jest.fn<AsyncMock>();
const mockGetCanonicalRepositoryItemStatuses = jest.fn<AsyncMock>();
const mockRetryCanonicalRepositoryItem = jest.fn<AsyncMock>();
const mockDispatchContentProcessingJob = jest.fn<AsyncMock>();
const mockRevalidatePath = jest.fn<(...args: unknown[]) => void>();
const mockTimer = jest.fn<(...args: unknown[]) => void>();

jest.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: mockGetServerSession,
}));
jest.mock("@/actions/repositories/repository-permissions", () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
}));
jest.mock("@/utils/roles", () => ({ hasRole: mockHasRole }));
jest.mock(
  "@/lib/repositories/content-platform/migration-control-service",
  () => ({
    approveRepositoryMigrationMismatch: jest.fn(),
    excludeRepositoryMigrationException:
      mockExcludeRepositoryMigrationException,
    getRepositoryMigrationDashboard: jest.fn(),
    listRepositoryMigrationExceptions: mockListRepositoryMigrationExceptions,
    MAX_FAILED_REPOSITORY_MIGRATION_RETRIES: 250,
    retryFailedRepositoryMigrationItems:
      mockRetryFailedRepositoryMigrationItems,
    retryRepositoryMigrationItem: jest.fn(),
    runRepositoryMigrationRollbackDrill: jest.fn(),
    startRepositoryMigrationRun: jest.fn(),
    startRepositoryRollbackRun: jest.fn(),
  }),
);
jest.mock("@/lib/repositories/content-platform/migration-runner", () => ({
  reprocessRepositoryMigrationItem: mockReprocessRepositoryMigrationItem,
}));
jest.mock("@/lib/repositories/content-platform/status-service", () => ({
  getCanonicalRepositoryItemStatuses:
    mockGetCanonicalRepositoryItemStatuses,
  retryCanonicalRepositoryItem: mockRetryCanonicalRepositoryItem,
}));
jest.mock("@/lib/repositories/content-platform/dispatch-service", () => ({
  dispatchContentProcessingJob: mockDispatchContentProcessingJob,
}));
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertNotSystemManagedRepository: mockAssertNotSystemManagedRepository,
  assertRepositoryReadAccess: jest.fn(),
}));
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: jest.fn(),
}));
jest.mock("@/lib/repositories/search-execution", () => ({
  executeSearch: jest.fn(),
}));
jest.mock("@/lib/db/drizzle", () => ({ getRepositoryById: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "recovery-test",
  getLogContext: () => ({}),
  sanitizeForLogging: (value: unknown) => value,
  startTimer: () => mockTimer,
}));

function status(
  itemId: number,
  overrides: Partial<CanonicalRepositoryItemStatus> = {},
): CanonicalRepositoryItemStatus {
  return {
    itemId,
    processingStatus: "embedded",
    processingError: null,
    canRetry: false,
    embeddedChunks: 10,
    totalChunks: 10,
    activeEmbeddingComplete: true,
    ...overrides,
  };
}

// eslint-disable-next-line max-lines-per-function -- The three actions share one administrator and service mock harness.
describe("repository recovery administrator actions", () => {
  let retryFailedRepositoryMigrationItemsAction: typeof import("@/actions/admin/repository-migration.actions").retryFailedRepositoryMigrationItemsAction;
  let reprocessRepositoryMigrationMismatchesAction: typeof import("@/actions/admin/repository-migration.actions").reprocessRepositoryMigrationMismatchesAction;
  let retryRepositoryItemsBulkAction: typeof import("@/actions/admin/repository-migration.actions").retryRepositoryItemsBulkAction;
  let excludeRepositoryMigrationExceptionAction: typeof import("@/actions/admin/repository-migration.actions").excludeRepositoryMigrationExceptionAction;

  beforeAll(async () => {
    ({
      retryFailedRepositoryMigrationItemsAction,
      reprocessRepositoryMigrationMismatchesAction,
      retryRepositoryItemsBulkAction,
      excludeRepositoryMigrationExceptionAction,
    } = await import("@/actions/admin/repository-migration.actions"));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ sub: "admin-sub" });
    mockGetUserIdFromSession.mockResolvedValue(7);
    mockHasRole.mockResolvedValue(true);
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined);
    mockListRepositoryMigrationExceptions.mockResolvedValue([]);
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(new Map());
    mockDispatchContentProcessingJob.mockResolvedValue(undefined);
  });

  it("queues a bounded failed migration set through one bulk service call", async () => {
    const run = { id: "run-1", mode: "backfill", status: "queued" };
    mockRetryFailedRepositoryMigrationItems.mockResolvedValue(run);

    const result = await retryFailedRepositoryMigrationItemsAction({
      limit: 219,
    });

    expect(result).toMatchObject({ isSuccess: true, data: run });
    expect(mockRetryFailedRepositoryMigrationItems).toHaveBeenCalledTimes(1);
    expect(mockRetryFailedRepositoryMigrationItems).toHaveBeenCalledWith({
      requestedBy: 7,
      limit: 219,
    });
  });

  it("records an audited administrator exclusion through the migration service", async () => {
    mockExcludeRepositoryMigrationException.mockResolvedValue(undefined);

    const result = await excludeRepositoryMigrationExceptionAction({
      migrationItemId: "migration-failed-1",
      reason: "The legacy object was intentionally removed after replacement.",
    });

    expect(result).toMatchObject({ isSuccess: true });
    expect(mockExcludeRepositoryMigrationException).toHaveBeenCalledWith({
      migrationItemId: "migration-failed-1",
      reason: "The legacy object was intentionally removed after replacement.",
      excludedBy: 7,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/repositories");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/settings");
  });

  it("rejects a failed migration retry beyond the 250-item bound", async () => {
    const result = await retryFailedRepositoryMigrationItemsAction({
      limit: 251,
    });

    expect(result).toMatchObject({
      isSuccess: false,
      message: "Limit must be between 1 and 250.",
    });
    expect(mockRetryFailedRepositoryMigrationItems).not.toHaveBeenCalled();
  });

  it("queries only mismatches and reports partial reprocess outcomes", async () => {
    mockListRepositoryMigrationExceptions.mockResolvedValue([
      { id: "mismatch-1", status: "mismatch" },
      { id: "mismatch-2", status: "mismatch" },
      { id: "mismatch-3", status: "mismatch" },
    ]);
    mockReprocessRepositoryMigrationItem.mockImplementation(async (...args) => {
      if (args[0] === "mismatch-2") throw new Error("State changed");
    });

    const result = await reprocessRepositoryMigrationMismatchesAction({
      limit: 3,
    });

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        reprocessed: 2,
        failed: 1,
        migrationItemIds: ["mismatch-1", "mismatch-3"],
        failedMigrationItemIds: ["mismatch-2"],
      },
    });
    expect(mockListRepositoryMigrationExceptions).toHaveBeenCalledWith(
      3,
      "mismatch",
    );
    expect(mockReprocessRepositoryMigrationItem.mock.calls).toEqual([
      ["mismatch-1"],
      ["mismatch-2"],
      ["mismatch-3"],
    ]);
  });

  it("selects repository 41's 73 completed under-embedded items without healthy content", async () => {
    const underEmbeddedItems = Array.from({ length: 73 }, (_, index) => {
      const itemId = 1_000 + index;
      return [
        itemId,
        status(itemId, {
          embeddedChunks: index === 0 ? 21_486 : 1,
          totalChunks: index === 0 ? 217_281 : 2,
          activeEmbeddingComplete: false,
        }),
      ] as const;
    });
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(
      new Map<number, CanonicalRepositoryItemStatus>([
        [1, status(1)],
        [
          2,
          status(2, {
            embeddedChunks: 1,
            totalChunks: 10,
            activeEmbeddingComplete: true,
          }),
        ],
        [
          3,
          status(3, {
            processingStatus: "retrying",
            embeddedChunks: 1,
            totalChunks: 10,
            activeEmbeddingComplete: false,
          }),
        ],
        ...underEmbeddedItems,
      ]),
    );
    mockRetryCanonicalRepositoryItem.mockImplementation(async (...args) => {
      const itemId = args[0] as number;
      return {
        itemVersionId: `version-${itemId}`,
        processingJobId: `job-${itemId}`,
      };
    });

    const result = await retryRepositoryItemsBulkAction({
      repositoryId: 41,
      limit: 100,
    });

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        retried: 73,
        dispatchDeferred: 0,
        itemIds: underEmbeddedItems.map(([itemId]) => itemId),
      },
    });
    expect(mockAssertNotSystemManagedRepository).toHaveBeenCalledWith(41);
    expect(mockRetryCanonicalRepositoryItem.mock.calls).toEqual(
      underEmbeddedItems.map(([itemId]) => [itemId, "recovery-test"]),
    );
  });

  it("also retries terminal and building under-embedded items with deferred dispatch", async () => {
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(
      new Map([
        [3, status(3, { processingStatus: "failed", canRetry: true })],
        [
          5,
          status(5, {
            processingStatus: "processing_embeddings",
            embeddedChunks: 0,
            totalChunks: 9,
          }),
        ],
        [7, status(7, { processingStatus: "failed", canRetry: true })],
        [
          6,
          status(6, {
            processingStatus: "pending",
            embeddedChunks: 0,
            totalChunks: 8,
            activeEmbeddingComplete: false,
          }),
        ],
      ]),
    );
    mockRetryCanonicalRepositoryItem.mockImplementation(async (...args) => {
      const itemId = args[0] as number;
      if (itemId === 5) throw new Error("Item state changed");
      return {
        itemVersionId: `version-${itemId}`,
        processingJobId: `job-${itemId}`,
      };
    });
    mockDispatchContentProcessingJob.mockImplementation(async (...args) => {
      const message = args[0] as { jobId: string };
      if (message.jobId === "job-3") throw new Error("SQS unavailable");
    });

    const result = await retryRepositoryItemsBulkAction({
      repositoryId: 41,
      limit: 100,
    });

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        retried: 2,
        failed: 1,
        dispatchDeferred: 1,
        itemIds: [3, 7],
        failedItemIds: [5],
      },
    });
    expect(mockRetryCanonicalRepositoryItem.mock.calls).toEqual([
      [3, "recovery-test"],
      [5, "recovery-test"],
      [7, "recovery-test"],
    ]);
    expect(mockRetryCanonicalRepositoryItem).not.toHaveBeenCalledWith(
      6,
      expect.anything(),
    );
  });
});
