/**
 * @jest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

const mockGetServerSession = jest.fn(() =>
  Promise.resolve({ sub: "reader-sub" } as { sub: string } | null)
)
const mockHasCapabilityAccess = jest.fn(() => Promise.resolve(true))
const mockAssertItemRepositoryReadAccess = jest.fn<
  (...args: unknown[]) => Promise<void>
>(() => Promise.resolve())
const mockGetRepositoryItemById = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockGetUserIdFromSession = jest.fn(() => Promise.resolve(22))
const mockCanModifyRepository = jest.fn(() => Promise.resolve(false))
const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown[]>>()

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: mockGetServerSession,
}))
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: mockHasCapabilityAccess,
}))
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertItemRepositoryReadAccess: mockAssertItemRepositoryReadAccess,
}))
jest.mock("@/lib/db/drizzle", () => ({
  getRepositoryItemById: mockGetRepositoryItemById,
}))
jest.mock("@/actions/repositories/repository-permissions", () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
  canModifyRepository: mockCanModifyRepository,
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: mockExecuteQuery,
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-id",
  startTimer: () => jest.fn(),
  getLogContext: () => ({}),
  sanitizeForLogging: (value: unknown) => value,
}))

const now = new Date("2026-07-23T12:00:00.000Z")
const item = {
  id: 41,
  repositoryId: 7,
  type: "document",
  name: "Handbook",
  source: "repositories/7/handbook.pdf",
  metadata: { originalFileName: "handbook.pdf" },
  currentVersionId: "version-2",
}
const version = {
  id: "version-2",
  itemId: 41,
  versionNumber: 2,
  sourceKind: "upload",
  sourceRevision: null,
  objectKey: "private/object-key",
  declaredContentType: "application/pdf",
  detectedContentType: "application/pdf",
  byteSize: 2048,
  sha256: "a".repeat(64),
  storageStatus: "available",
  inspectionStatus: "clean",
  inspectionDetails: {},
  processingStatus: "completed",
  processorVersion: "processor-v2",
  metadata: { originalFileName: "handbook.pdf" },
  createdBy: 22,
  createdAt: now,
}
const job = {
  id: "job-1",
  itemVersionId: "version-2",
  stage: "publish",
  status: "failed",
  idempotencyKey: "secret-idempotency-key",
  attempt: 1,
  maxAttempts: 3,
  lastErrorCode: "STORAGE_DENIED",
  lastErrorMessage: "private bucket path",
  startedAt: now,
  finishedAt: now,
  createdAt: now,
  updatedAt: now,
}
const artifact = {
  id: "artifact-1",
  itemVersionId: "version-2",
  artifactKey: "private-artifact-key",
  kind: "canonical_text",
  mediaType: "text/markdown",
  pageFrom: 1,
  pageTo: 2,
  timeStartMs: null,
  timeEndMs: null,
  processorName: "pdf-normalizer",
  processorVersion: "2",
  createdAt: now,
}
const citation = {
  chunkId: 90,
  itemVersionId: "version-2",
  artifactId: "artifact-1",
  chunkIndex: 0,
  modality: "text",
  sourceLocator: { page: 1, headingPath: ["Welcome"] },
}

describe("repository item management projection", () => {
  let getRepositoryItemManagementView: typeof import("@/actions/repositories/repository-management.actions").getRepositoryItemManagementView

  beforeAll(async () => {
    ;({ getRepositoryItemManagementView } = await import(
      "@/actions/repositories/repository-management.actions"
    ))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockExecuteQuery.mockReset()
    mockGetServerSession.mockResolvedValue({ sub: "reader-sub" })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockAssertItemRepositoryReadAccess.mockResolvedValue(undefined)
    mockGetRepositoryItemById.mockResolvedValue(item)
    mockGetUserIdFromSession.mockResolvedValue(22)
    mockCanModifyRepository.mockResolvedValue(false)
    mockExecuteQuery
      .mockResolvedValueOnce([version])
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([artifact])
      .mockResolvedValueOnce([{ activeIndexGenerationId: "generation-1" }])
      .mockResolvedValueOnce([citation])
  })

  it("returns immutable versions, processing, artifacts, and exact active citations", async () => {
    const result = await getRepositoryItemManagementView(41)

    expect(result.isSuccess).toBe(true)
    expect(result.data).toMatchObject({
      itemId: 41,
      sourceSummary: "handbook.pdf",
      currentVersionId: "version-2",
      canManage: false,
      versions: [
        expect.objectContaining({
          id: "version-2",
          versionNumber: 2,
          isCurrent: true,
        }),
      ],
      artifacts: [
        expect.objectContaining({
          id: "artifact-1",
          kind: "canonical_text",
        }),
      ],
      citations: [
        expect.objectContaining({
          itemVersionId: "version-2",
          sourceLocator: { page: 1, headingPath: ["Welcome"] },
        }),
      ],
    })
  })

  it("redacts operational error details from shared readers", async () => {
    const result = await getRepositoryItemManagementView(41)

    expect(result.data?.jobs[0]).toMatchObject({
      lastErrorCode: null,
      lastErrorMessage: null,
    })
  })

  it("preserves operational error details for repository managers", async () => {
    mockCanModifyRepository.mockResolvedValue(true)

    const result = await getRepositoryItemManagementView(41)

    expect(result.data?.jobs[0]).toMatchObject({
      lastErrorCode: "STORAGE_DENIED",
      lastErrorMessage: "private bucket path",
    })
  })

  it("stops before loading item metadata when read access is denied", async () => {
    mockAssertItemRepositoryReadAccess.mockRejectedValue(
      new Error("Record not found")
    )

    const result = await getRepositoryItemManagementView(41)

    expect(result.isSuccess).toBe(false)
    expect(mockGetRepositoryItemById).not.toHaveBeenCalled()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("authenticates before branching on a caller-controlled item id", async () => {
    mockGetServerSession.mockResolvedValue(null)

    const result = await getRepositoryItemManagementView(-1)

    expect(result.isSuccess).toBe(false)
    expect(mockGetServerSession).toHaveBeenCalledTimes(1)
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled()
    expect(mockAssertItemRepositoryReadAccess).not.toHaveBeenCalled()
    expect(mockGetRepositoryItemById).not.toHaveBeenCalled()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })
})
