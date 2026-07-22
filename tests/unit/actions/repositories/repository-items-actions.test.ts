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
const mockUploadDocument = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockQueueFileForProcessing = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockRegisterCanonicalUploadIfEnabled = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  () => Promise.resolve(null)
)
const mockDispatchContentProcessingJob = jest.fn<(...a: unknown[]) => Promise<void>>(
  () => Promise.resolve()
)
const mockGetDocumentObjectMetadata = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockGetDocumentSignedUrl = jest.fn<(...a: unknown[]) => Promise<string>>()
const mockCopyRepositorySourceToCanonicalNamespace = jest.fn<
  (...a: unknown[]) => Promise<{ key: string }>
>()
const mockDeleteRepositoryItem = jest.fn<(...a: unknown[]) => Promise<number>>()
const mockDeleteRepositoryItemStorage = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockGetCanonicalRepositoryItemStatuses = jest.fn<
  (...a: unknown[]) => Promise<Map<number, {
    processingStatus: string
    processingError: string | null
    canRetry: boolean
  }>>
>(() => Promise.resolve(new Map()))
const mockRetryCanonicalRepositoryItem = jest.fn<
  (...a: unknown[]) => Promise<{ itemVersionId: string; processingJobId: string }>
>()
const mockAssertCanonicalRetryNotQuarantined = jest.fn<
  (...a: unknown[]) => Promise<void>
>(() => Promise.resolve())
const mockRegisterCanonicalTextIfEnabled = jest.fn<
  (...a: unknown[]) => Promise<unknown>
>(() => Promise.resolve(null))
const mockExecuteTransaction = jest.fn<
  (...a: unknown[]) => Promise<unknown>
>()
const mockRepositoryItemsTable = { table: 'repository_items' }
const mockRepositoryItemChunksTable = { table: 'repository_item_chunks' }

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
  deleteRepositoryItem: mockDeleteRepositoryItem,
  updateRepositoryItemStatus: mockUpdateRepositoryItemStatus,
}))
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: jest.fn(() => Promise.resolve([])),
  executeTransaction: mockExecuteTransaction,
  repositoryItems: mockRepositoryItemsTable,
  repositoryItemChunks: mockRepositoryItemChunksTable,
}))
jest.mock('@/lib/aws/s3-client', () => ({
  copyRepositorySourceToCanonicalNamespace: mockCopyRepositorySourceToCanonicalNamespace,
  uploadDocument: mockUploadDocument,
  deleteDocument: jest.fn(),
  getDocumentObjectMetadata: mockGetDocumentObjectMetadata,
  getDocumentSignedUrl: mockGetDocumentSignedUrl,
}))
jest.mock('@/lib/services/file-processing-service', () => ({
  queueFileForProcessing: mockQueueFileForProcessing,
  processUrl: jest.fn(),
}))
jest.mock('@/lib/repositories/content-platform', () => ({
  isCanonicalUploadContentType: (contentType: string) => [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
  ].includes(contentType),
  isRepositorySourceObjectKey: (repositoryId: number, objectKey: string) =>
    new RegExp(
      `^repositories/${repositoryId}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[^/]+$`,
      'i'
    ).test(objectKey) &&
    !objectKey.includes('..'),
  registerCanonicalTextIfEnabled: mockRegisterCanonicalTextIfEnabled,
  registerCanonicalUploadIfEnabled: mockRegisterCanonicalUploadIfEnabled,
  dispatchContentProcessingJob: mockDispatchContentProcessingJob,
  deleteRepositoryItemStorage: mockDeleteRepositoryItemStorage,
  getCanonicalRepositoryItemStatuses: mockGetCanonicalRepositoryItemStatuses,
  retryCanonicalRepositoryItem: mockRetryCanonicalRepositoryItem,
  assertCanonicalRetryNotQuarantined: mockAssertCanonicalRetryNotQuarantined,
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
    mockGetRepositoryItems.mockResolvedValue([])
    mockAssertRepositoryReadAccess.mockResolvedValue(undefined)
    mockAssertItemRepositoryReadAccess.mockResolvedValue(undefined)
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined)
    mockRegisterCanonicalUploadIfEnabled.mockResolvedValue(null)
    mockRegisterCanonicalTextIfEnabled.mockResolvedValue(null)
    mockExecuteTransaction.mockReset()
    mockDispatchContentProcessingJob.mockResolvedValue(undefined)
    mockUpdateRepositoryItemStatus.mockResolvedValue(undefined)
    mockUploadDocument.mockResolvedValue({
      key: 'repositories/7/11111111-2222-4333-8444-555555555555/document.pdf',
      url: 's3://documents/repositories/7/11111111-2222-4333-8444-555555555555/document.pdf',
    })
    mockQueueFileForProcessing.mockResolvedValue('legacy-job')
    mockGetDocumentObjectMetadata.mockResolvedValue({
      contentLength: 1,
      contentType: 'application/pdf',
      eTag: 'etag-1',
      metadata: {},
    })
    mockGetDocumentSignedUrl.mockResolvedValue('https://download')
    mockCopyRepositorySourceToCanonicalNamespace.mockResolvedValue({
      key: 'repositories/5/11111111-2222-4333-8444-555555555555/legacy.pdf',
    })
    mockDeleteRepositoryItem.mockResolvedValue(1)
    mockDeleteRepositoryItemStorage.mockResolvedValue({
      sourceObjectCount: 1,
      artifactObjectCount: 3,
    })
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(new Map())
    mockRetryCanonicalRepositoryItem.mockResolvedValue({
      itemVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      processingJobId: 'ffffffff-1111-4222-8333-444444444444',
    })
    mockAssertCanonicalRetryNotQuarantined.mockResolvedValue(undefined)
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

  it('projects canonical failure state instead of a misleading legacy completion', async () => {
    mockGetRepositoryItems.mockResolvedValue([{
      id: 38,
      repositoryId: 5,
      type: 'text',
      name: 'Inline notes',
      source: 'content',
      metadata: {},
      processingStatus: 'completed',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }])
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(new Map([[38, {
      processingStatus: 'failed',
      processingError: 'Item version object key is outside its repository namespace',
      canRetry: true,
    }]]))

    const result = await mod.listRepositoryItems(5)

    expect(result.isSuccess).toBe(true)
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 38,
        processingStatus: 'failed',
        processingError: 'Item version object key is outside its repository namespace',
        canRetry: true,
      }),
    ])
  })

  it('retries a failed canonical item through its durable job', async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 38,
      repositoryId: 5,
      type: 'document',
      source: 'repositories/5/11111111-2222-4333-8444-555555555555/source.pdf',
      currentVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })

    const result = await mod.retryRepositoryItemProcessing(38)

    expect(result.isSuccess).toBe(true)
    expect(mockRetryCanonicalRepositoryItem).toHaveBeenCalledWith(38, 't')
    expect(mockAssertCanonicalRetryNotQuarantined).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: 'ffffffff-1111-4222-8333-444444444444',
      itemVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
  })

  it('repairs failed inline text by creating a fresh immutable source version', async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 38,
      repositoryId: 5,
      type: 'text',
      name: 'Inline notes',
      source: 'ORCHID-COMPASS-742',
      currentVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    mockRegisterCanonicalTextIfEnabled.mockResolvedValue({
      created: true,
      version: { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
      inspectJob: { id: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa' },
    })

    const result = await mod.retryRepositoryItemProcessing(38)

    expect(result.isSuccess).toBe(true)
    expect(mockRegisterCanonicalTextIfEnabled).toHaveBeenCalledWith({
      itemId: 38,
      repositoryId: 5,
      userId: 1,
      name: 'Inline notes',
      content: 'ORCHID-COMPASS-742',
      traceId: 't',
    })
    expect(mockAssertCanonicalRetryNotQuarantined).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
    expect(mockRetryCanonicalRepositoryItem).not.toHaveBeenCalled()
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
      itemVersionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    })
  })

  it('does not let inline text supersede a post-deployment recovery quarantine', async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 38,
      repositoryId: 5,
      type: 'text',
      name: 'Inline notes',
      source: 'ORCHID-COMPASS-742',
      currentVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    mockAssertCanonicalRetryNotQuarantined.mockRejectedValue(
      new Error('This item is awaiting automatic post-deployment recovery')
    )

    const result = await mod.retryRepositoryItemProcessing(38)

    expect(result.isSuccess).toBe(false)
    expect(mockRegisterCanonicalTextIfEnabled).not.toHaveBeenCalled()
    expect(mockRetryCanonicalRepositoryItem).not.toHaveBeenCalled()
    expect(mockDispatchContentProcessingJob).not.toHaveBeenCalled()
  })

  it('repairs a legacy file by copying it into the canonical source namespace', async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 39,
      repositoryId: 5,
      type: 'document',
      name: 'Legacy document',
      source: '1/1700000000-legacy.pdf',
      metadata: {
        originalFileName: 'legacy.pdf',
        contentType: 'application/pdf',
      },
      currentVersionId: null,
    })
    mockRegisterCanonicalUploadIfEnabled.mockResolvedValue({
      created: true,
      version: { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
      inspectJob: { id: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa' },
    })

    const result = await mod.retryRepositoryItemProcessing(39)

    expect(result.isSuccess).toBe(true)
    expect(mockCopyRepositorySourceToCanonicalNamespace).toHaveBeenCalledWith({
      repositoryId: 5,
      sourceKey: '1/1700000000-legacy.pdf',
      fileName: 'legacy.pdf',
    })
    expect(mockRegisterCanonicalUploadIfEnabled).toHaveBeenCalledWith({
      itemId: 39,
      userId: 1,
      objectKey: 'repositories/5/11111111-2222-4333-8444-555555555555/legacy.pdf',
      originalFileName: 'legacy.pdf',
      declaredContentType: 'application/pdf',
      byteSize: 1,
      traceId: 't',
    })
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
      itemVersionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    })
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
      s3Key: 'repositories/7/11111111-2222-4333-8444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })
    expect(res.isSuccess).toBe(true)
    expect(mockCreateRepositoryItem).toHaveBeenCalledTimes(1)
    expect(mockRegisterCanonicalUploadIfEnabled).toHaveBeenCalledWith({
      itemId: 1,
      userId: 1,
      objectKey: 'repositories/7/11111111-2222-4333-8444-555555555555/doc.pdf',
      originalFileName: 'doc.pdf',
      declaredContentType: 'application/pdf',
      byteSize: 1,
      traceId: 't',
    })
  })

  it('rejects a nested repository key that the canonical worker cannot process', async () => {
    const res = await mod.addDocumentWithPresignedUrl({
      repository_id: 7,
      name: 'doc',
      s3Key: 'repositories/7/inline/11111111-2222-4333-8444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })

    expect(res.isSuccess).toBe(false)
    expect(mockGetDocumentObjectMetadata).not.toHaveBeenCalled()
    expect(mockCreateRepositoryItem).not.toHaveBeenCalled()
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

  it('registers direct document uploads with the canonical pipeline', async () => {
    mockCreateRepositoryItem.mockResolvedValue({
      id: 4,
      repositoryId: 7,
      type: 'document',
      name: 'Direct document',
      source: 'repositories/7/11111111-2222-4333-8444-555555555555/document.pdf',
      metadata: {},
      processingStatus: 'pending',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    mockRegisterCanonicalUploadIfEnabled.mockResolvedValue({
      created: true,
      version: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      inspectJob: { id: 'ffffffff-1111-4222-8333-444444444444' },
    })

    const result = await mod.addDocumentItem({
      repository_id: 7,
      name: 'Direct document',
      file: {
        content: Buffer.from('pdf-bytes'),
        contentType: 'application/pdf',
        size: 9,
        fileName: 'document.pdf',
      },
    })

    expect(result.isSuccess).toBe(true)
    expect(mockUploadDocument).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 7,
      fileName: 'document.pdf',
    }))
    expect(mockRegisterCanonicalUploadIfEnabled).toHaveBeenCalledWith({
      itemId: 4,
      userId: 1,
      objectKey: 'repositories/7/11111111-2222-4333-8444-555555555555/document.pdf',
      originalFileName: 'document.pdf',
      declaredContentType: 'application/pdf',
      byteSize: 9,
      traceId: 't',
    })
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: 'ffffffff-1111-4222-8333-444444444444',
      itemVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    expect(mockQueueFileForProcessing).toHaveBeenCalledWith(
      4,
      'repositories/7/11111111-2222-4333-8444-555555555555/document.pdf',
      'Direct document',
      'application/pdf'
    )
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
      s3Key: 'repositories/7/11111111-2222-4333-8444-555555555555/doc.pdf',
      metadata: { contentType: 'application/pdf', size: 1, originalFileName: 'doc.pdf' },
    })

    expect(res.isSuccess).toBe(true)
  })

  it('dispatches inline text through the canonical processing pipeline', async () => {
    const itemValues = jest.fn(() => ({
      returning: jest.fn(() => Promise.resolve([{ id: 37 }])),
    }))
    const chunkValues = jest.fn(() => Promise.resolve())
    const insert = jest.fn((table: unknown) =>
      table === mockRepositoryItemsTable
        ? { values: itemValues }
        : { values: chunkValues }
    )
    mockExecuteTransaction.mockImplementation(async (...args: unknown[]) => {
      const operation = args[0]
      if (typeof operation !== 'function') {
        throw new Error('Expected a transaction callback')
      }
      return (operation as (tx: unknown) => Promise<unknown>)({ insert })
    })
    mockGetRepositoryItemById.mockResolvedValue({
      id: 37,
      repositoryId: 7,
      type: 'text',
      name: 'Live validation',
      source: 'ORCHID-COMPASS-742',
      metadata: {},
      processingStatus: 'completed',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    mockRegisterCanonicalTextIfEnabled.mockResolvedValue({
      created: true,
      version: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      inspectJob: { id: 'ffffffff-1111-4222-8333-444444444444' },
    })

    const result = await mod.addTextItem({
      repository_id: 7,
      name: 'Live validation',
      content: 'ORCHID-COMPASS-742',
    })

    expect(result.isSuccess).toBe(true)
    expect(mockRegisterCanonicalTextIfEnabled).toHaveBeenCalledWith({
      itemId: 37,
      repositoryId: 7,
      userId: 1,
      name: 'Live validation',
      content: 'ORCHID-COMPASS-742',
      traceId: 't',
    })
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: 'ffffffff-1111-4222-8333-444444444444',
      itemVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
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
      s3Key: 'repositories/7/11111111-2222-4333-8444-555555555555/doc.pdf',
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

  it('removes image source and derivative storage before deleting the item row', async () => {
    const image = {
      id: 9,
      repositoryId: 5,
      type: 'image',
      name: 'Evacuation map',
      source: 'repositories/5/upload/map.png',
      metadata: {},
      processingStatus: 'completed',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockGetRepositoryItemById.mockResolvedValue(image)

    const result = await mod.removeRepositoryItem(9)

    expect(result.isSuccess).toBe(true)
    expect(mockDeleteRepositoryItemStorage).toHaveBeenCalledWith(
      expect.objectContaining(image)
    )
    expect(mockDeleteRepositoryItemStorage.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteRepositoryItem.mock.invocationCallOrder[0]
    )
  })

  it('cleans canonical storage for inline text before deleting its manifest', async () => {
    const textItem = {
      id: 11,
      repositoryId: 5,
      type: 'text',
      name: 'Emergency notes',
      source: 'Inline text is not an S3 key',
      metadata: {},
      processingStatus: 'completed',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockGetRepositoryItemById.mockResolvedValue(textItem)

    const result = await mod.removeRepositoryItem(11)

    expect(result.isSuccess).toBe(true)
    expect(mockDeleteRepositoryItemStorage).toHaveBeenCalledWith(
      expect.objectContaining(textItem)
    )
  })

  it('preserves the item manifest when storage cleanup fails', async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 12,
      repositoryId: 5,
      type: 'video',
      name: 'Training video',
      source: 'repositories/5/11111111-2222-4333-8444-555555555555/training.mp4',
      metadata: {},
      processingStatus: 'completed',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    mockDeleteRepositoryItemStorage.mockRejectedValueOnce(
      new Error('storage unavailable')
    )

    const result = await mod.removeRepositoryItem(12)

    expect(result.isSuccess).toBe(false)
    expect(mockDeleteRepositoryItem).not.toHaveBeenCalled()
  })

  it('generates image download URLs through database-first S3 settings', async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 10,
      repositoryId: 5,
      type: 'image',
      name: 'Evacuation map',
      source: 'repositories/5/upload/map.png',
      metadata: { originalFileName: 'map.png' },
      processingStatus: 'completed',
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await mod.getDocumentDownloadUrl(10)

    expect(result.isSuccess).toBe(true)
    expect(mockGetDocumentSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'repositories/5/upload/map.png' })
    )
  })
})
