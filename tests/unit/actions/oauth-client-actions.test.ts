/**
 * @jest-environment node
 *
 * revokeOAuthClient (REV-COR-055): a revoke that matches no client must return a
 * failure ActionState, not a false "revoked" success.
 */
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals'

const mockRequireRole = jest.fn<() => Promise<void>>(() => Promise.resolve())
const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))

jest.mock('@/lib/auth/role-helpers', () => ({ requireRole: mockRequireRole }))
jest.mock('@/lib/db/drizzle-client', () => ({ executeQuery: mockExecuteQuery }))
jest.mock('@/lib/auth/server-session', () => ({ getServerSession: jest.fn(() => Promise.resolve({ sub: 'admin' })) }))
jest.mock('@/lib/db/drizzle/utils', () => ({ getUserIdByCognitoSubAsNumber: jest.fn(() => Promise.resolve(1)) }))
jest.mock('@/lib/api-keys/argon2-loader', () => ({ hashArgon2: jest.fn() }))
jest.mock('@/lib/db/schema', () => ({
  oauthClients: { id: 'id', clientId: 'client_id', isActive: 'is_active', updatedAt: 'updated_at' },
}))
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => 't', startTimer: () => jest.fn(), sanitizeForLogging: (x: unknown) => x,
  getLogContext: () => ({}),
}))

describe('revokeOAuthClient (REV-COR-055)', () => {
  let revokeOAuthClient: typeof import('@/actions/oauth/oauth-client.actions').revokeOAuthClient
  beforeAll(async () => { revokeOAuthClient = (await import('@/actions/oauth/oauth-client.actions')).revokeOAuthClient })
  beforeEach(() => { jest.clearAllMocks(); mockRequireRole.mockResolvedValue(undefined) })

  it('returns a failure when no client matches the id (no false success)', async () => {
    mockExecuteQuery.mockResolvedValueOnce([]) // UPDATE matched 0 rows
    const res = await revokeOAuthClient('does-not-exist')
    expect(res.isSuccess).toBe(false)
  })

  it('returns success when an existing client is revoked', async () => {
    mockExecuteQuery.mockResolvedValueOnce([{ id: 7 }]) // one row updated
    const res = await revokeOAuthClient('client-abc')
    expect(res.isSuccess).toBe(true)
    expect(res.data).toEqual({ clientId: 'client-abc' })
  })
})
