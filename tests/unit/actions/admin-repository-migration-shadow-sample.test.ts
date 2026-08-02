/** @jest-environment node */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetServerSession = jest.fn();
const mockGetUserIdFromSession = jest.fn();
const mockHasRole = jest.fn();
const mockGetRepositoryById = jest.fn();
const mockAssertRepositoryReadAccess = jest.fn();
const mockGetContentPlatformConfig = jest.fn();
const mockExecuteSearch = jest.fn();
const mockRevalidatePath = jest.fn();
const mockTimer = jest.fn();

jest.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: mockGetServerSession,
}));
jest.mock("@/actions/repositories/repository-permissions", () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
}));
jest.mock("@/utils/roles", () => ({ hasRole: mockHasRole }));
jest.mock("@/lib/db/drizzle", () => ({
  getRepositoryById: mockGetRepositoryById,
}));
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertRepositoryReadAccess: mockAssertRepositoryReadAccess,
}));
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: mockGetContentPlatformConfig,
}));
jest.mock("@/lib/repositories/search-execution", () => ({
  executeSearch: mockExecuteSearch,
}));
jest.mock(
  "@/lib/repositories/content-platform/migration-control-service",
  () => ({
    approveRepositoryMigrationMismatch: jest.fn(),
    getRepositoryMigrationDashboard: jest.fn(),
    listRepositoryMigrationExceptions: jest.fn(),
    retryRepositoryMigrationItem: jest.fn(),
    runRepositoryMigrationRollbackDrill: jest.fn(),
    startRepositoryMigrationRun: jest.fn(),
    startRepositoryRollbackRun: jest.fn(),
  }),
);
jest.mock("@/lib/repositories/content-platform/migration-runner", () => ({
  reprocessRepositoryMigrationItem: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "shadow-sample-test",
  getLogContext: () => ({}),
  sanitizeForLogging: (value: unknown) => value,
  startTimer: () => mockTimer,
}));

// eslint-disable-next-line max-lines-per-function -- One action contract with shared auth/search setup.
describe("recordRepositoryRetrievalShadowSampleAction", () => {
  let recordRepositoryRetrievalShadowSampleAction: typeof import("@/actions/admin/repository-migration.actions").recordRepositoryRetrievalShadowSampleAction;

  beforeAll(async () => {
    ({ recordRepositoryRetrievalShadowSampleAction } = await import(
      "@/actions/admin/repository-migration.actions"
    ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ sub: "admin-sub" });
    mockGetUserIdFromSession.mockResolvedValue(7);
    mockHasRole.mockResolvedValue(true);
    mockGetRepositoryById.mockResolvedValue({ id: 41, name: "Policy Library" });
    mockAssertRepositoryReadAccess.mockResolvedValue(undefined);
    mockGetContentPlatformConfig.mockResolvedValue({
      enabled: true,
      readV2Enabled: true,
      retrievalShadowEnabled: true,
    });
    mockExecuteSearch.mockResolvedValue({
      results: [],
      shadowOutcome: { status: "recorded" },
    });
  });

  it("requires the administrator role before validating or searching", async () => {
    mockHasRole.mockResolvedValue(false);

    const result = await recordRepositoryRetrievalShadowSampleAction({
      repositoryId: 41,
      queries: ["attendance policy"],
    });

    expect(result.isSuccess).toBe(false);
    expect(mockGetRepositoryById).not.toHaveBeenCalled();
    expect(mockExecuteSearch).not.toHaveBeenCalled();
  });

  it("enforces the 25-query cap", async () => {
    const result = await recordRepositoryRetrievalShadowSampleAction({
      repositoryId: 41,
      queries: Array.from({ length: 26 }, (_, index) => `query ${index}`),
    });

    expect(result).toMatchObject({
      isSuccess: false,
      message: "Provide between 1 and 25 sample queries.",
    });
    expect(mockGetRepositoryById).not.toHaveBeenCalled();
    expect(mockExecuteSearch).not.toHaveBeenCalled();
  });

  it("rejects an empty query", async () => {
    const result = await recordRepositoryRetrievalShadowSampleAction({
      repositoryId: 41,
      queries: ["attendance policy", "   "],
    });

    expect(result).toMatchObject({
      isSuccess: false,
      message: "Sample query 2 must not be empty.",
    });
    expect(mockExecuteSearch).not.toHaveBeenCalled();
  });

  it("runs each trimmed query in order through executeSearch with canonicalOnly false", async () => {
    mockExecuteSearch
      .mockResolvedValueOnce({
        results: [{ itemId: 1 }],
        shadowOutcome: { status: "recorded" },
      })
      .mockResolvedValueOnce({
        results: [{ itemId: 2 }, { itemId: 3 }],
        shadowOutcome: {
          status: "skipped",
          reason: "Retrieval shadow recording is disabled",
        },
      });

    const result = await recordRepositoryRetrievalShadowSampleAction({
      repositoryId: 41,
      queries: ["  attendance policy ", "emergency closure"],
    });

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        repositoryId: 41,
        repositoryName: "Policy Library",
        recorded: 1,
        skipped: 1,
        outcomes: [
          {
            query: "attendance policy",
            status: "recorded",
            resultCount: 1,
          },
          {
            query: "emergency closure",
            status: "skipped",
            resultCount: 2,
            reason: "Retrieval shadow recording is disabled",
          },
        ],
      },
    });
    expect(mockExecuteSearch).toHaveBeenCalledTimes(2);
    expect(mockExecuteSearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        canonicalOnly: false,
        query: "attendance policy",
        repositoryId: 41,
        userCognitoSub: "admin-sub",
      }),
    );
    expect(mockExecuteSearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        canonicalOnly: false,
        query: "emergency closure",
        repositoryId: 41,
      }),
    );
  });

  it("reports a repository access failure with the repository name", async () => {
    mockAssertRepositoryReadAccess.mockRejectedValue(
      Object.assign(new Error("masked"), { code: "DB_RECORD_NOT_FOUND" }),
    );

    const result = await recordRepositoryRetrievalShadowSampleAction({
      repositoryId: 41,
      queries: ["attendance policy"],
    });

    expect(result).toMatchObject({
      isSuccess: false,
      message:
        'Access to repository "Policy Library" is required before recording a retrieval-shadow sample.',
    });
    expect(mockExecuteSearch).not.toHaveBeenCalled();
  });

  it("keeps a shadow failure fail-open and reports the query as skipped", async () => {
    mockExecuteSearch.mockResolvedValue({
      results: [{ itemId: 1 }],
      shadowOutcome: {
        status: "skipped",
        reason: "Canonical retrieval shadow failed; legacy results were served",
      },
    });

    const result = await recordRepositoryRetrievalShadowSampleAction({
      repositoryId: 41,
      queries: ["attendance policy"],
    });

    expect(result).toMatchObject({
      isSuccess: true,
      data: {
        recorded: 0,
        skipped: 1,
        outcomes: [
          {
            status: "skipped",
            reason:
              "Canonical retrieval shadow failed; legacy results were served",
          },
        ],
      },
    });
  });

  it("does not write the observations table or invoke the recorder directly", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "actions/admin/repository-migration.actions.ts",
      ),
      "utf8",
    );

    expect(source).not.toContain("repository_retrieval_shadow_observations");
    expect(source).not.toMatch(/\brecordRepositoryRetrievalShadow\(/);
  });
});
