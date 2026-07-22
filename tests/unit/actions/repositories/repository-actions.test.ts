/**
 * @jest-environment node
 *
 * repository.actions authorization + correctness:
 *   REV-SEC-082 getRepository per-repo access (IDOR), REV-SEC-083
 *   getRepositoryAccess owner-only, REV-COR-064 no-op update returns a Repository.
 */
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals'

const mockGetServerSession = jest.fn(() => Promise.resolve({ sub: 'u' } as { sub: string } | null))
const mockHasCapabilityAccess = jest.fn(() => Promise.resolve(true))
const mockGetUserIdFromSession = jest.fn(() => Promise.resolve(1))
const mockCanModifyRepository = jest.fn(() => Promise.resolve(true))
const mockAssertRepositoryReadAccess = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockAssertNotSystemManagedRepository = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockGetRepositoryById = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockGetRepositoryAccessList = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockExecuteQuery = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockGetRepositoryItems = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockDeleteRepository = jest.fn<(...a: unknown[]) => Promise<number>>()
const mockDeleteRepositoryItemStorage = jest.fn<(...a: unknown[]) => Promise<unknown>>()

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/utils/roles', () => ({ hasCapabilityAccess: mockHasCapabilityAccess }))
jest.mock('@/actions/repositories/repository-permissions', () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
  canModifyRepository: mockCanModifyRepository,
}))
jest.mock('@/lib/repositories/repository-access-guard', () => ({
  assertRepositoryReadAccess: mockAssertRepositoryReadAccess,
  assertNotSystemManagedRepository: mockAssertNotSystemManagedRepository,
}))
jest.mock('@/lib/db/drizzle', () => ({
  getRepositoryById: mockGetRepositoryById,
  getRepositoryAccessList: mockGetRepositoryAccessList,
  createRepository: jest.fn(), updateRepository: jest.fn(), deleteRepository: mockDeleteRepository,
  getRepositoriesByOwnerId: jest.fn(() => Promise.resolve([])),
  getRepositoryItems: mockGetRepositoryItems,
  grantUserAccess: jest.fn(), grantRoleAccess: jest.fn(), revokeAccessById: jest.fn(),
  getUserAccessibleRepositories: jest.fn(() => Promise.resolve([])),
}))
jest.mock('@/lib/db/drizzle-client', () => ({ executeQuery: mockExecuteQuery }))
jest.mock('@/lib/db/schema', () => ({ repositoryAccess: {}, repositoryItems: { repositoryId: 'repository_id' } }))
jest.mock('@/lib/repositories/content-platform/storage-cleanup', () => ({
  deleteRepositoryItemStorage: mockDeleteRepositoryItemStorage,
}))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x, getLogContext: () => ({}),
}))

const rawRepo = { id: 5, name: 'R', description: null, ownerId: 1, isPublic: false, metadata: {}, createdAt: new Date(), updatedAt: new Date() }

describe('repository.actions authorization (REV-SEC-082 / REV-SEC-083 / REV-COR-064)', () => {
  let mod: typeof import('@/actions/repositories/repository.actions')
  beforeAll(async () => { mod = await import('@/actions/repositories/repository.actions') })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockGetUserIdFromSession.mockResolvedValue(1)
    mockCanModifyRepository.mockResolvedValue(true)
    mockAssertRepositoryReadAccess.mockResolvedValue(undefined)
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined)
    mockExecuteQuery.mockResolvedValue([])
    mockGetRepositoryItems.mockResolvedValue([])
    mockDeleteRepository.mockResolvedValue(1)
    mockDeleteRepositoryItemStorage.mockResolvedValue({
      sourceObjectCount: 1,
      artifactObjectCount: 3,
    })
  })

  it('getRepository returns not-found when the caller lacks read access (REV-SEC-082)', async () => {
    mockAssertRepositoryReadAccess.mockRejectedValue(new Error('Record not found'))
    const res = await mod.getRepository(999)
    expect(res.isSuccess).toBe(false)
    expect(mockGetRepositoryById).not.toHaveBeenCalled()
  })

  it('getRepository returns data for an authorized caller', async () => {
    mockGetRepositoryById.mockResolvedValue(rawRepo)
    const res = await mod.getRepository(5)
    expect(res.isSuccess).toBe(true)
    expect(res.data?.id).toBe(5)
  })

  it('getRepositoryAccess rejects a non-owner/admin (REV-SEC-083)', async () => {
    mockCanModifyRepository.mockResolvedValue(false)
    const res = await mod.getRepositoryAccess(7)
    expect(res.isSuccess).toBe(false)
    expect(mockGetRepositoryAccessList).not.toHaveBeenCalled()
  })

  it('getRepositoryAccess returns the list for an owner/admin', async () => {
    mockGetRepositoryAccessList.mockResolvedValue([{ userId: 2 }])
    const res = await mod.getRepositoryAccess(7)
    expect(res.isSuccess).toBe(true)
  })

  it('updateRepository no-op returns the current repository, not null (REV-COR-064)', async () => {
    mockGetRepositoryById.mockResolvedValue(rawRepo)
    const res = await mod.updateRepository({ id: 5 } as never)
    expect(res.isSuccess).toBe(true)
    expect(res.data).not.toBeNull()
    expect(res.data?.id).toBe(5)
  })

  it('cleans image storage before deleting a repository', async () => {
    const image = {
      id: 19,
      repositoryId: 5,
      type: 'image',
      name: 'Map',
      source: 'repositories/5/upload/map.png',
    }
    mockGetRepositoryItems.mockResolvedValue([image])

    const res = await mod.deleteRepository(5)

    expect(res.isSuccess).toBe(true)
    expect(mockDeleteRepositoryItemStorage).toHaveBeenCalledWith(image)
    expect(mockDeleteRepositoryItemStorage.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteRepository.mock.invocationCallOrder[0]
    )
  })
})
