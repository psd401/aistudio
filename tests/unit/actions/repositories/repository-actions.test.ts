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
const mockHasRole = jest.fn(() => Promise.resolve(false))
const mockGetUserIdFromSession = jest.fn(() => Promise.resolve(1))
const mockCanModifyRepository = jest.fn(() => Promise.resolve(true))
const mockAssertRepositoryReadAccess = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockAssertNotSystemManagedRepository = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockAssertDeletionBoundary = jest.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
const mockGetRepositoryById = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockGetRepositoryAccessList = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockExecuteQuery = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockGetRepositoryItems = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockDeleteRepository = jest.fn<(...a: unknown[]) => Promise<number>>()
const mockDeleteRepositoryStorageTree = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockBeginRepositoryDeletion = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
const mockFinalizeRepositoryDeletion = jest.fn<(...a: unknown[]) => Promise<boolean>>(() => Promise.resolve(true))
const mockGetUserAccessibleRepositories = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/utils/roles', () => ({
  hasCapabilityAccess: mockHasCapabilityAccess,
  hasRole: mockHasRole,
}))
jest.mock('@/actions/repositories/repository-permissions', () => ({
  getUserIdFromSession: mockGetUserIdFromSession,
  canModifyRepository: mockCanModifyRepository,
}))
jest.mock('@/lib/repositories/repository-access-guard', () => ({
  assertRepositoryReadAccess: mockAssertRepositoryReadAccess,
  assertNotSystemManagedRepository: mockAssertNotSystemManagedRepository,
  assertUserManagedDurableRepositoryForDeletion: mockAssertDeletionBoundary,
}))
jest.mock('@/lib/db/drizzle', () => ({
  getRepositoryById: mockGetRepositoryById,
  getRepositoryAccessList: mockGetRepositoryAccessList,
  createRepository: jest.fn(), updateRepository: jest.fn(), deleteRepository: mockDeleteRepository,
  getRepositoriesByOwnerId: jest.fn(() => Promise.resolve([])),
  getRepositoryItems: mockGetRepositoryItems,
  grantUserAccess: jest.fn(), grantRoleAccess: jest.fn(), revokeAccessById: jest.fn(),
  getUserAccessibleRepositories: mockGetUserAccessibleRepositories,
}))
jest.mock('@/lib/db/drizzle-client', () => ({ executeQuery: mockExecuteQuery }))
jest.mock('@/lib/db/schema', () => ({ repositoryAccess: {}, repositoryItems: { repositoryId: 'repository_id' } }))
jest.mock('@/lib/repositories/content-platform/storage-cleanup', () => ({
  deleteRepositoryStorageTree: mockDeleteRepositoryStorageTree,
}))
jest.mock('@/lib/repositories/content-platform/deletion-service', () => ({
  beginRepositoryDeletion: mockBeginRepositoryDeletion,
  finalizeRepositoryDeletion: mockFinalizeRepositoryDeletion,
}))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x, getLogContext: () => ({}),
}))

const rawRepo = {
  id: 5,
  name: 'R',
  description: null,
  ownerId: 1,
  isPublic: false,
  repositoryKind: 'durable' as const,
  lifecycleStatus: 'active' as const,
  retentionDays: null,
  expiresAt: null,
  activeIndexGenerationId: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('repository.actions authorization (REV-SEC-082 / REV-SEC-083 / REV-COR-064)', () => {
  let mod: typeof import('@/actions/repositories/repository.actions')
  beforeAll(async () => { mod = await import('@/actions/repositories/repository.actions') })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockHasRole.mockResolvedValue(false)
    mockGetUserIdFromSession.mockResolvedValue(1)
    mockCanModifyRepository.mockResolvedValue(true)
    mockAssertRepositoryReadAccess.mockResolvedValue(undefined)
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined)
    mockAssertDeletionBoundary.mockResolvedValue(undefined)
    mockExecuteQuery.mockResolvedValue([])
    mockGetRepositoryItems.mockResolvedValue([])
    mockDeleteRepository.mockResolvedValue(1)
    mockBeginRepositoryDeletion.mockResolvedValue([])
    mockFinalizeRepositoryDeletion.mockResolvedValue(true)
    mockDeleteRepositoryStorageTree.mockResolvedValue({
      itemCount: 0,
      sourceObjectCount: 0,
      artifactObjectCount: 0,
      repositoryObjectCount: 0,
    })
    mockGetUserAccessibleRepositories.mockResolvedValue([])
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
    expect(res.data?.canManage).toBe(true)
  })

  it('lists owned and shared durable repositories with management projections', async () => {
    mockGetUserAccessibleRepositories.mockResolvedValue([
      {
        ...rawRepo,
        ownerName: 'Owner One',
        itemCount: 2,
        lastUpdated: new Date(),
      },
      {
        ...rawRepo,
        id: 6,
        name: 'Shared',
        ownerId: 9,
        ownerName: 'Owner Nine',
        itemCount: 3,
        lastUpdated: new Date(),
      },
    ])

    const res = await mod.listRepositories()

    expect(res.isSuccess).toBe(true)
    expect(res.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 5, canManage: true }),
        expect.objectContaining({ id: 6, canManage: false }),
      ])
    )
  })

  it('keeps an interrupted owner deletion reachable after list reload', async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      {
        ...rawRepo,
        lifecycleStatus: 'deleting',
        ownerName: 'Owner One',
        itemCount: 2,
        lastUpdated: new Date(),
      },
    ])

    const res = await mod.listRepositories()

    expect(res.isSuccess).toBe(true)
    expect(res.data).toEqual([
      expect.objectContaining({
        id: 5,
        lifecycleStatus: 'deleting',
        canManage: true,
      }),
    ])
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

  it('pages user grant options without truncating the ACL search silently', async () => {
    mockExecuteQuery
      .mockResolvedValueOnce(
        Array.from({ length: 51 }, (_, index) => ({
          id: index + 1,
          email: `user-${index + 1}@example.com`,
          firstName: `User ${index + 1}`,
          lastName: null,
        }))
      )
      .mockResolvedValueOnce([{ id: 3, name: 'staff' }])

    const res = await mod.getRepositoryAccessOptions(7, 'user', 0)

    expect(res.isSuccess).toBe(true)
    expect(res.data?.users).toHaveLength(50)
    expect(res.data?.roles).toEqual([{ id: 3, name: 'staff' }])
    expect(res.data?.nextUserOffset).toBe(50)
  })

  it('rejects an invalid user grant page offset', async () => {
    const res = await mod.getRepositoryAccessOptions(7, '', -1)

    expect(res.isSuccess).toBe(false)
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it('updateRepository no-op returns the current repository, not null (REV-COR-064)', async () => {
    mockGetRepositoryById.mockResolvedValue(rawRepo)
    const res = await mod.updateRepository({ id: 5 } as never)
    expect(res.isSuccess).toBe(true)
    expect(res.data).not.toBeNull()
    expect(res.data?.id).toBe(5)
  })

  it('cleans every repository item type and its root prefix before deleting manifests', async () => {
    const items = ['text', 'document', 'image', 'audio', 'video'].map(
      (type, index) => ({
        id: index + 19,
        repositoryId: 5,
        type,
        name: `Item ${index + 1}`,
        source:
          type === 'text'
            ? 'Inline source'
            : `repositories/5/upload/source-${index + 1}`,
      })
    )
    mockBeginRepositoryDeletion.mockResolvedValue(items)

    const res = await mod.deleteRepository(5)

    expect(res.isSuccess).toBe(true)
    expect(mockBeginRepositoryDeletion).toHaveBeenCalledWith(5)
    expect(mockDeleteRepositoryStorageTree).toHaveBeenCalledWith(5, items)
    expect(mockDeleteRepositoryStorageTree.mock.invocationCallOrder[0]).toBeLessThan(
      mockFinalizeRepositoryDeletion.mock.invocationCallOrder[0]
    )
  })

  it('preserves repository manifests when durable storage cleanup fails', async () => {
    mockBeginRepositoryDeletion.mockResolvedValue([
      {
        id: 19,
        repositoryId: 5,
        type: 'document',
        source: 'repositories/5/upload/source.pdf',
      },
    ])
    mockDeleteRepositoryStorageTree.mockRejectedValueOnce(
      new Error('storage unavailable')
    )

    const res = await mod.deleteRepository(5)

    expect(res.isSuccess).toBe(false)
    expect(mockFinalizeRepositoryDeletion).not.toHaveBeenCalled()
  })

  it('masks non-durable repositories before checking ownership or storage', async () => {
    mockAssertDeletionBoundary.mockRejectedValueOnce(
      new Error('Record not found')
    )

    const res = await mod.deleteRepository(5)

    expect(res.isSuccess).toBe(false)
    expect(mockCanModifyRepository).not.toHaveBeenCalled()
    expect(mockBeginRepositoryDeletion).not.toHaveBeenCalled()
    expect(mockDeleteRepositoryStorageTree).not.toHaveBeenCalled()
    expect(mockFinalizeRepositoryDeletion).not.toHaveBeenCalled()
  })
})
