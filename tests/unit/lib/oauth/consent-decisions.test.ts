/**
 * @jest-environment node
 *
 * consumeConsentDecision (REV-COR-050): atomic consume-once of an OAuth consent
 * decision, moved out of the "use server" action surface into a server-only lib.
 */
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals'

jest.mock('server-only', () => ({}))
const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))
jest.mock('@/lib/db/drizzle-client', () => ({ executeQuery: mockExecuteQuery }))
jest.mock('@/lib/db/schema', () => ({ oauthConsentDecisions: { uid: 'uid', expiresAt: 'expires_at' } }))

describe('consumeConsentDecision (REV-COR-050)', () => {
  let consume: typeof import('@/lib/oauth/consent-decisions').consumeConsentDecision
  beforeAll(async () => { consume = (await import('@/lib/oauth/consent-decisions')).consumeConsentDecision })
  beforeEach(() => { jest.clearAllMocks() })

  it('returns the mapped decision and consumes it in ONE atomic statement', async () => {
    const row = { approved: true, userId: 42, scopes: ['read'], createdAt: new Date(1000) }
    mockExecuteQuery.mockResolvedValueOnce([row])
    const first = await consume('uid-1')
    expect(first).toEqual({ approved: true, userId: 42, scopes: ['read'], createdAt: 1000 })
    // Exactly one executeQuery — a single DELETE ... RETURNING, not select+delete.
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
    expect(mockExecuteQuery.mock.calls[0][1]).toBe('consumeConsentDecision')
  })

  it('returns undefined on a second read of the same uid (already consumed)', async () => {
    mockExecuteQuery.mockResolvedValueOnce([{ approved: true, userId: 1, scopes: [], createdAt: new Date() }])
    mockExecuteQuery.mockResolvedValueOnce([]) // row deleted by the first consume
    await consume('uid-2')
    expect(await consume('uid-2')).toBeUndefined()
  })

  it('returns undefined for an unknown or expired uid (no matching row)', async () => {
    mockExecuteQuery.mockResolvedValueOnce([])
    expect(await consume('missing-or-expired')).toBeUndefined()
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
  })
})
