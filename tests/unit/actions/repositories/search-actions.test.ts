/**
 * @jest-environment node
 *
 * searchRepository authorization (REV-COR-062 / REV-SEC-081): capability gate,
 * repositoryId validation (no global-search fallthrough), per-repo access, and
 * limit/vectorWeight clamping.
 */
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals'

const mockGetServerSession = jest.fn(() => Promise.resolve({ sub: 'u' } as { sub: string } | null))
const mockHasCapabilityAccess = jest.fn(() => Promise.resolve(true))
const mockAssertRepositoryReadAccess = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockVector = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockKeyword = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockHybrid = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockRetrieveV2 = jest.fn<(...a: unknown[]) => Promise<{ results: unknown[]; diagnostics: Record<string, unknown> }>>(
  () => Promise.resolve({ results: [], diagnostics: {} })
)
const mockIsCanonicalRepositoryUploadActive = jest.fn(() => false)
const mockGetContentPlatformConfig = jest.fn(() => Promise.resolve({
  enabled: false,
  readV2Enabled: false,
  retrievalShadowEnabled: false,
}))
const mockRecordRepositoryRetrievalShadow = jest.fn(() => Promise.resolve())
const mockWarn = jest.fn()

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/utils/roles', () => ({ hasCapabilityAccess: mockHasCapabilityAccess }))
jest.mock('@/lib/repositories/repository-access-guard', () => ({
  assertRepositoryReadAccess: mockAssertRepositoryReadAccess,
}))
jest.mock('@/lib/repositories/content-platform/config', () => ({
  getContentPlatformConfig: mockGetContentPlatformConfig,
  isCanonicalRepositoryUploadActive: mockIsCanonicalRepositoryUploadActive,
}))
jest.mock('@/lib/repositories/content-platform/retrieval-shadow', () => ({
  recordRepositoryRetrievalShadow: mockRecordRepositoryRetrievalShadow,
}))
jest.mock('@/lib/repositories/retrieval-v2/service', () => ({
  retrieveRepositoryContent: mockRetrieveV2,
}))
jest.mock('@/lib/repositories/search-service', () => ({
  vectorSearch: mockVector, keywordSearch: mockKeyword, hybridSearch: mockHybrid,
}))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: mockWarn, error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x, getLogContext: () => ({}),
}))

describe('searchRepository authorization (REV-COR-062 / REV-SEC-081)', () => {
  let searchRepository: typeof import('@/actions/repositories/search.actions').searchRepository
  beforeAll(async () => { searchRepository = (await import('@/actions/repositories/search.actions')).searchRepository })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockAssertRepositoryReadAccess.mockResolvedValue(undefined)
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(false)
    mockGetContentPlatformConfig.mockResolvedValue({
      enabled: false,
      readV2Enabled: false,
      retrievalShadowEnabled: false,
    })
    mockRetrieveV2.mockResolvedValue({ results: [], diagnostics: {} })
  })

  it('rejects a caller lacking the knowledge-repositories capability', async () => {
    mockHasCapabilityAccess.mockResolvedValue(false)
    const res = await searchRepository({ query: 'x', repositoryId: 5 })
    expect(res.isSuccess).toBe(false)
    expect(mockHybrid).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects repositoryId=%p and never searches', async (rid) => {
    const res = await searchRepository({ query: 'x', repositoryId: rid as number })
    expect(res.isSuccess).toBe(false)
    expect(mockVector).not.toHaveBeenCalled()
    expect(mockKeyword).not.toHaveBeenCalled()
    expect(mockHybrid).not.toHaveBeenCalled()
  })

  it('rejects when the caller has no access to the repository', async () => {
    mockAssertRepositoryReadAccess.mockRejectedValue(new Error('Record not found'))
    const res = await searchRepository({ query: 'x', repositoryId: 5 })
    expect(res.isSuccess).toBe(false)
    expect(mockHybrid).not.toHaveBeenCalled()
  })

  it('clamps limit and vectorWeight before searching', async () => {
    await searchRepository({ query: 'x', repositoryId: 5, searchType: 'hybrid', limit: 100000, vectorWeight: 9 })
    expect(mockHybrid).toHaveBeenCalledWith('x', {
      repositoryId: 5,
      limit: 50,
      vectorWeight: 1,
      canonicalOnly: false,
    })
  })

  it('allows an authorized search and returns results', async () => {
    mockVector.mockResolvedValue([{ id: 1, content: 'hit' }])
    const res = await searchRepository({ query: 'x', repositoryId: 5, searchType: 'vector' })
    expect(res.isSuccess).toBe(true)
  })

  it('uses shared generation-pinned retrieval when canonical reads are active', async () => {
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(true)
    mockRetrieveV2.mockResolvedValue({
      results: [
        {
          chunkId: 1,
          itemId: 2,
          itemName: 'Policy',
          content: 'content',
          similarity: 0.8,
          chunkIndex: 0,
          metadata: {},
          itemStableId: 'stable',
          itemVersionId: 'version',
          versionNumber: 3,
          sourceLocator: { page: 2 },
        },
      ],
      diagnostics: {},
    })

    const result = await searchRepository({
      query: 'policy',
      repositoryId: 5,
      searchType: 'hybrid',
      vectorWeight: 0.4,
    })

    expect(result.isSuccess).toBe(true)
    expect(mockRetrieveV2).toHaveBeenCalledWith({
      query: 'policy',
      repositoryIds: [5],
      userCognitoSub: 'u',
      mode: 'hybrid',
      limit: 10,
      denseWeight: 0.4,
      includeLegacyCompatibility: false,
    })
    expect(mockHybrid).not.toHaveBeenCalled()
  })

  it('records an enabled shadow observation through the shared executor', async () => {
    mockGetContentPlatformConfig.mockResolvedValue({
      enabled: true,
      readV2Enabled: true,
      retrievalShadowEnabled: true,
    })
    mockHybrid.mockResolvedValue([{ itemId: 11 }])
    mockRetrieveV2.mockResolvedValue({
      results: [{ itemId: 11 }],
      diagnostics: {},
    })

    const result = await searchRepository({
      query: 'policy',
      repositoryId: 5,
    })

    expect(result.isSuccess).toBe(true)
    expect(mockRecordRepositoryRetrievalShadow).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 5,
        product: 'repository_manager',
        searchMode: 'hybrid',
        legacyItemIds: [11],
        canonicalItemIds: [11],
      })
    )
  })

  it('keeps legacy search successful when the canonical shadow fails', async () => {
    mockGetContentPlatformConfig.mockResolvedValue({
      enabled: true,
      readV2Enabled: true,
      retrievalShadowEnabled: true,
    })
    mockHybrid.mockResolvedValue([{ itemId: 11 }])
    mockRetrieveV2.mockRejectedValue(new Error('canonical unavailable'))

    const result = await searchRepository({
      query: 'policy',
      repositoryId: 5,
    })

    expect(result.isSuccess).toBe(true)
    expect(mockRecordRepositoryRetrievalShadow).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith(
      'Canonical retrieval shadow failed without affecting legacy search',
      { error: 'canonical unavailable' }
    )
  })
})
