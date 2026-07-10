/**
 * @jest-environment node
 *
 * jobs-actions ownership authorization (REV-COR-038): every action must
 * authorize by the OWNING user, not just session presence — no IDOR read/
 * update/delete, and createJob cannot attribute a job to another user.
 */
import { describe, it, expect, jest, beforeEach, beforeAll } from '@jest/globals'

const mockGetServerSession = jest.fn(() => Promise.resolve({ sub: 'u' } as { sub: string } | null))
const mockGetCurrentUserAction = jest.fn(() => Promise.resolve({ isSuccess: true, data: { user: { id: 1 } } } as unknown))
const mockHasRole = jest.fn(() => Promise.resolve(false))
const mockCreateGenericJob = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockGetGenericJobById = jest.fn<() => Promise<unknown>>()
const mockGetGenericJobsByUserId = jest.fn<() => Promise<unknown[]>>(() => Promise.resolve([]))
const mockUpdateGenericJob = jest.fn<() => Promise<unknown>>()
const mockDeleteGenericJob = jest.fn<() => Promise<unknown>>()
const mockGetUserById = jest.fn<(userId: number) => Promise<unknown>>()

jest.mock('@/lib/auth/server-session', () => ({ getServerSession: mockGetServerSession }))
jest.mock('@/actions/db/get-current-user-action', () => ({ getCurrentUserAction: mockGetCurrentUserAction }))
jest.mock('@/utils/roles', () => ({ hasRole: mockHasRole, hasCapabilityAccess: jest.fn() }))
jest.mock('@/lib/db/drizzle', () => ({
  createGenericJob: mockCreateGenericJob,
  getGenericJobById: mockGetGenericJobById,
  getGenericJobsByUserId: mockGetGenericJobsByUserId,
  updateGenericJob: mockUpdateGenericJob,
  deleteGenericJob: mockDeleteGenericJob,
  getUserById: mockGetUserById,
}))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({}),
}))

describe('jobs-actions ownership (REV-COR-038)', () => {
  let mod: typeof import('@/actions/db/jobs-actions')
  beforeAll(async () => { mod = await import('@/actions/db/jobs-actions') })
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'u' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockHasRole.mockResolvedValue(false)
  })

  it('createJobAction rejects a non-admin attributing a job to another user', async () => {
    const res = await mod.createJobAction({ type: 't', input: {}, userId: 999 } as never)
    expect(res.isSuccess).toBe(false)
    expect(mockCreateGenericJob).not.toHaveBeenCalled()
  })

  it('createJobAction attributes the job to the caller when no userId is supplied', async () => {
    mockCreateGenericJob.mockResolvedValue({ id: 5, type: 't', status: 'pending' })
    const res = await mod.createJobAction({ type: 't', input: {} } as never)
    expect(res.isSuccess).toBe(true)
    expect(mockCreateGenericJob).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }))
  })

  it('an administrator may create a job on behalf of an existing user', async () => {
    mockHasRole.mockResolvedValue(true)
    mockGetUserById.mockResolvedValue({ id: 999 })
    mockCreateGenericJob.mockResolvedValue({ id: 6, type: 't', status: 'pending' })
    const res = await mod.createJobAction({ type: 't', input: {}, userId: 999 } as never)
    expect(res.isSuccess).toBe(true)
    expect(mockGetUserById).toHaveBeenCalledWith(999)
    expect(mockCreateGenericJob).toHaveBeenCalledWith(expect.objectContaining({ userId: 999 }))
  })

  it('createJobAction rejects an administrator targeting a nonexistent user', async () => {
    mockHasRole.mockResolvedValue(true)
    mockGetUserById.mockRejectedValue(new Error('not found'))
    const res = await mod.createJobAction({ type: 't', input: {}, userId: 999 } as never)
    expect(res.isSuccess).toBe(false)
    expect(mockCreateGenericJob).not.toHaveBeenCalled()
  })

  it("getJobAction returns not-found for another user's job", async () => {
    mockGetGenericJobById.mockResolvedValue({ id: 7, userId: 999, type: 't', status: 'done' })
    const res = await mod.getJobAction('7')
    expect(res.isSuccess).toBe(false)
  })

  it("getUserJobsAction refuses to list another user's jobs", async () => {
    const res = await mod.getUserJobsAction('999')
    expect(res.isSuccess).toBe(false)
    expect(mockGetGenericJobsByUserId).not.toHaveBeenCalled()
  })

  it("deleteJobAction refuses to delete another user's job", async () => {
    mockGetGenericJobById.mockResolvedValue({ id: 8, userId: 999 })
    const res = await mod.deleteJobAction('8')
    expect(res.isSuccess).toBe(false)
    expect(mockDeleteGenericJob).not.toHaveBeenCalled()
  })

  it("updateJobAction refuses to update another user's job", async () => {
    mockGetGenericJobById.mockResolvedValue({ id: 8, userId: 999 })
    const res = await mod.updateJobAction('8', { status: 'failed' } as never)
    expect(res.isSuccess).toBe(false)
    expect(mockUpdateGenericJob).not.toHaveBeenCalled()
  })

  it('an administrator may act on another user\'s job', async () => {
    mockHasRole.mockResolvedValue(true)
    mockGetGenericJobById.mockResolvedValue({ id: 9, userId: 999, type: 't', status: 'done' })
    const res = await mod.getJobAction('9')
    expect(res.isSuccess).toBe(true)
  })

  it('the owner may read their own job', async () => {
    mockGetGenericJobById.mockResolvedValue({ id: 10, userId: 1, type: 't', status: 'done' })
    const res = await mod.getJobAction('10')
    expect(res.isSuccess).toBe(true)
  })
})
