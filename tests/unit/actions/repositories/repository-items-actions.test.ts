/**
 * @jest-environment node
 *
 * repository-items.actions:
 *   REV-COR-061 per-repo access on reads, REV-SEC-062 s3Key namespace check,
 *   REV-COR-068 processing-status validation.
 */
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals'

const mockGetServerSession = jest.fn(() => Promise.resolve({ sub: 'u' } as { sub: string } | null))
const mockHasCapabilityAccess = jest.fn(() => Promise.resolve(true))
const mockGetUserIdFromSession = jest.fn(() => Promise.resolve(1))
const mockCanModifyRepository = jest.fn(() => Promise.resolve(true))
const mockAssertRepositoryReadAccess = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockAssertItemRepositoryReadAccess = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockAssertNotSystemManagedRepository = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockGetRepositoryItems = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockGetRepositoryItemById = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockCreateRepositoryItem = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockUpdateRepositoryItemStatus = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockRegisterCanonicalUploadIfEnabled = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  () => Promise.resolve(null)
)
const mockDispatchContentProcessingJob = jest.fn<(...a: unknown[]) => Promise<void>>(
  () => Promise.resolve()
)
const mockGetDocumentObjectMetadata = jest.fn<(...a: unknown[]) => Promise<unknown>>()

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/utils/roles', () => ({ hasCapabilityAccess: mockHasCapabilityAccess }))
jest.mock('./repository-permissions', () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
  canModifyRepository: mockCanModifyRepository,
}), { virtual: true })
jest.mock('@/actions/repositories/repository-permissions', () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
  canModifyRepository: mockCanModifyRepository,
}))
jest.mock('@/lib/repositories/repository-access-guard', () => ({
  assertRepositoryReadAccess: mockAssertRepositoryReadAccess,
  assertItemRepositoryReadAccess: mockAssertItemRepositoryReadAccess,
  assertNotSystemManagedRepository: mockAssertNotSystemManagedRepository,
}))
jest.mock('@/lib/repositories/content-disposition', () => ({ toContentDispositionValue: (s: string) => s }))
jest.mock('@/lib/db/drizzle', () => ({
  createRepositoryItem: mockCreateRepositoryItem,
  getRepositoryItemById: mockGetRepositoryItemById,
  getRepositoryItems: mockGetRepositoryItems,
  getRepositoryItemChunks: jest.fn(() => Promise.resolve([])),
  deleteRepositoryItem: jest.fn(),
  updateRepositoryItemStatus: mockUpdateRepositoryItemStatus,
}))
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: jest.fn(() => Promise.resolve([])),
  executeTransaction: jest.fn(),
  repositoryItems: {}, repositoryItemChunks: {},
}))
jest.mock('@/lib/aws/s3-client', () => ({
  uploadDocument: jest.fn(),
  deleteDocument: jest.fn(),
  getDocumentObjectMetadata: mockGetDocumentObjectMetadata,
}))
jest.mock('@/lib/services/file-processing-service', () => ({ queueFileForProcessing: jest.fn(), processUrl: jest.fn() }))
jest.mock('@/lib/repositories/content-platform', () => ({
  registerCanonicalUploadIfEnabled: mockRegisterCanonicalUploadIfEnabled,
  dispatchContentProcessingJob: mockDispatchContentProcessingJob,
}))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x, getLogContext: () => ({}),
}))

describe('repository-items.actions (REV-COR-061 / REV-SEC-062 / REV-COR-068)', () => {
  let mod: typeof import('@/actions/repositories/repository-items.actions')
  beforeAll(async () => { mod = await import('@/actions/repositories/repository-items.actions') })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockGetUserIdFromSession.mockResolvedValue(1)
    mockCanModifyRepository.mockResolvedValue(true)
    mockAssertRepositoryReadAccess.mockResolvedValue(undefined)
    mockAssertItemRepositoryReadAccess.mockResolvedValue(undefined)
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined)
    mockRegisterCanonicalUploadIfEnabled.mockResolvedValue(null)
    mockDispatchContentProcessingJob.mockResolvedValue(undefined)
    mockGetDocumentObjectMetadata.mockResolvedValue({
      contentLength: 1,
      contentType: 'application/pdf',
      eTag: 'etag-1',
      metadata: {},
    })
  })

  it('listRepositoryItems denies a caller without read access (REV-COR-061)', async () => {
    mockAssertRepositoryReadAccess.mockRejectedValue(new Error('Record not found'))
    const res = await mod.listRepositoryItems(999)
    expect(res.isSuccess).toBe(false)
    expect(mockGetRepositoryItems).not.toHaveBeenCalled()
  })

  it('listRepositoryItems succeeds for an authorized caller', async () => {
    const res = await mod.listRepositoryItems(5)
    expect(res.isSuccess).toBe(true)
    expect(mockGetRepositoryItems).toHaveBeenCalledWith(5)
  })

  it('addDocumentWithPresignedUrl rejects an s3Key outside the repository namespace (REV-SEC-062)', async () => {
    const res = await mod.addDocumentWithPresignedUrl({
      repository_id: 7,
      name: 'doc',
      s3Key: '3/1699999999-secret.pdf', // another user's upload prefix
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'secret.pdf' },
    })
    expect(res.isSuccess).toBe(false)
    expect(mockCreateRepositoryItem).not.toHaveBeenCalled()
  })

  it('addDocumentWithPresignedUrl accepts an in-namespace key', async () => {
    mockCreateRepositoryItem.mockResolvedValue({
      id: 1, repositoryId: 7, type: 'document', name: 'doc', source: 'repositories/7/abc/doc.pdf',
      metadata: {}, processingStatus: 'pending', processingError: null, createdAt: new Date(), updatedAt: new Date(),
    })
    const res = await mod.addDocumentWithPresignedUrl({
      repository_id: 7,
      name: 'doc',
      s3Key: 'repositories/7/11111111-2222-3333-4444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })
    expect(res.isSuccess).toBe(true)
    expect(mockCreateRepositoryItem).toHaveBeenCalledTimes(1)
    expect(mockRegisterCanonicalUploadIfEnabled).toHaveBeenCalledWith({
      itemId: 1,
      userId: 1,
      objectKey: 'repositories/7/11111111-2222-3333-4444-555555555555/doc.pdf',
      originalFileName: 'doc.pdf',
      declaredContentType: 'application/pdf',
      byteSize: 1,
      traceId: 't',
    })
  })

  it('dispatches a canonical shadow-write job without replacing the legacy flow', async () => {
    mockCreateRepositoryItem.mockResolvedValue({
      id: 3, repositoryId: 7, type: 'document', name: 'doc', source: 'repositories/7/abc/doc.pdf',
      metadata: {}, processingStatus: 'pending', processingError: null, createdAt: new Date(), updatedAt: new Date(),
    })
    mockRegisterCanonicalUploadIfEnabled.mockResolvedValue({
      created: true,
      version: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      inspectJob: { id: 'ffffffff-1111-4222-8333-444444444444' },
    })

    const res = await mod.addDocumentWithPresignedUrl({
      repository_id: 7,
      name: 'doc',
      s3Key: 'repositories/7/11111111-2222-4333-8444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })

    expect(res.isSuccess).toBe(true)
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: 'ffffffff-1111-4222-8333-444444444444',
      itemVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
  })

  it('keeps the legacy upload available when the canonical shadow write fails', async () => {
    mockCreateRepositoryItem.mockResolvedValue({
      id: 2, repositoryId: 7, type: 'document', name: 'doc', source: 'repositories/7/abc/doc.pdf',
      metadata: {}, processingStatus: 'pending', processingError: null, createdAt: new Date(), updatedAt: new Date(),
    })
    mockRegisterCanonicalUploadIfEnabled.mockRejectedValue(new Error('canonical unavailable'))

    const res = await mod.addDocumentWithPresignedUrl({
      repository_id: 7,
      name: 'doc',
      s3Key: 'repositories/7/11111111-2222-3333-4444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })

    expect(res.isSuccess).toBe(true)
  })

  it('rejects a presigned upload when the stored object size differs', async () => {
    mockGetDocumentObjectMetadata.mockResolvedValue({
      contentLength: 99,
      contentType: 'application/pdf',
      eTag: 'etag-1',
      metadata: {},
    })

    const res = await mod.addDocumentWithPresignedUrl({
      repository_id: 7,
      name: 'doc',
      s3Key: 'repositories/7/11111111-2222-3333-4444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })

    expect(res.isSuccess).toBe(false)
    expect(mockCreateRepositoryItem).not.toHaveBeenCalled()
  })

  it('updateItemProcessingStatus rejects an invalid status with no DB write (REV-COR-068)', async () => {
    const res = await mod.updateItemProcessingStatus(1, 'bogus')
    expect(res.isSuccess).toBe(false)
    expect(mockUpdateRepositoryItemStatus).not.toHaveBeenCalled()
  })

  it('updateItemProcessingStatus accepts a valid status for an authorized caller', async () => {
    mockGetRepositoryItemById.mockResolvedValue({ id: 1, repositoryId: 5 })
    const res = await mod.updateItemProcessingStatus(1, 'completed')
    expect(res.isSuccess).toBe(true)
    expect(mockUpdateRepositoryItemStatus).toHaveBeenCalledWith(1, 'completed', null)
  })
})
