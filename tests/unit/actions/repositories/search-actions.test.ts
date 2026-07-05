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
const mockGetUserIdFromSession = jest.fn(() => Promise.resolve(1))
const mockCanReadRepository = jest.fn(() => Promise.resolve(true))
const mockVector = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockKeyword = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockHybrid = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/utils/roles', () => ({ hasCapabilityAccess: mockHasCapabilityAccess }))
jest.mock('@/actions/repositories/repository-permissions', () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
  canReadRepository: mockCanReadRepository,
}))
jest.mock('@/lib/repositories/search-service', () => ({
  vectorSearch: mockVector, keywordSearch: mockKeyword, hybridSearch: mockHybrid,
}))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x, getLogContext: () => ({}),
}))

describe('searchRepository authorization (REV-COR-062 / REV-SEC-081)', () => {
  let searchRepository: typeof import('@/actions/repositories/search.actions').searchRepository
  beforeAll(async () => { searchRepository = (await import('@/actions/repositories/search.actions')).searchRepository })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockGetUserIdFromSession.mockResolvedValue(1)
    mockCanReadRepository.mockResolvedValue(true)
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
    mockCanReadRepository.mockResolvedValue(false)
    const res = await searchRepository({ query: 'x', repositoryId: 5 })
    expect(res.isSuccess).toBe(false)
    expect(mockHybrid).not.toHaveBeenCalled()
  })

  it('clamps limit and vectorWeight before searching', async () => {
    await searchRepository({ query: 'x', repositoryId: 5, searchType: 'hybrid', limit: 100000, vectorWeight: 9 })
    expect(mockHybrid).toHaveBeenCalledWith('x', { repositoryId: 5, limit: 50, vectorWeight: 1 })
  })

  it('allows an authorized search and returns results', async () => {
    mockVector.mockResolvedValue([{ id: 1, content: 'hit' }])
    const res = await searchRepository({ query: 'x', repositoryId: 5, searchType: 'vector' })
    expect(res.isSuccess).toBe(true)
  })
})
