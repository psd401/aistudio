/**
 * @jest-environment node
 *
 * navigation-actions admin gate (REV-COR-039): create/update/delete mutate the
 * GLOBAL navigation tree and must require administrator, not mere authentication
 * (a non-admin could otherwise add/retarget items or clear a nav item's gate).
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals'

const mockGetServerSession = jest.fn(() => Promise.resolve({ sub: 'u' } as { sub: string } | null))
const mockHasRole = jest.fn(() => Promise.resolve(false))
const mockCreate = jest.fn<() => Promise<unknown>>()
const mockUpdate = jest.fn<() => Promise<unknown>>()
const mockDelete = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/utils/roles', () => ({ hasRole: mockHasRole }))
jest.mock('@/lib/db/drizzle', () => ({
  getNavigationItems: jest.fn(() => Promise.resolve([])),
  createNavigationItem: mockCreate,
  updateNavigationItem: mockUpdate,
  deleteNavigationItem: mockDelete,
}))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({}),
}))

describe('navigation-actions admin gate (REV-COR-039)', () => {
  let mod: typeof import('@/actions/db/navigation-actions')
  beforeAll(async () => { mod = await import('@/actions/db/navigation-actions') })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockHasRole.mockResolvedValue(false)
  })

  it('rejects a non-admin creating a navigation item (no row created)', async () => {
    const res = await mod.createNavigationItemAction({ label: 'Evil', link: '/x' } as never)
    expect(res.isSuccess).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a non-admin updating a navigation item (cannot clear its gate)', async () => {
    const res = await mod.updateNavigationItemAction('1', { capabilityId: null } as never)
    expect(res.isSuccess).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects a non-admin deleting a navigation item', async () => {
    const res = await mod.deleteNavigationItemAction('1')
    expect(res.isSuccess).toBe(false)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('allows an administrator to delete a navigation item', async () => {
    mockHasRole.mockResolvedValue(true)
    mockDelete.mockResolvedValue(true)
    const res = await mod.deleteNavigationItemAction('1')
    expect(res.isSuccess).toBe(true)
    expect(mockDelete).toHaveBeenCalledWith(1)
  })
})
