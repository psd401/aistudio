/**
 * Tests for POST /api/nexus/messages (REV-SEC-145 scoped upsert + REV-SEC-143
 * strip client storage refs).
 *
 * SEC-145: the upsert keys on a client-supplied messageId whose conflict target is
 * the message PK alone, so a caller could overwrite another user's message by
 * pairing their own owned conversationId with the victim's messageId. The fix
 * rejects a messageId that already exists under a different conversation.
 * SEC-143: client-supplied s3Key/imageUrl storage references are stripped from
 * inbound parts (only server save paths may set them).
 */

const mockGetServerSession = jest.fn()
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock('@/actions/db/get-current-user-action', () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

const mockUpsertMessageWithStats = jest.fn()
const mockGetConversationById = jest.fn()
const mockGetMessageById = jest.fn()
jest.mock('@/lib/db/drizzle', () => ({
  upsertMessageWithStats: (...a: unknown[]) => mockUpsertMessageWithStats(...a),
  getConversationById: (...a: unknown[]) => mockGetConversationById(...a),
  getMessageById: (...a: unknown[]) => mockGetMessageById(...a),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((d: unknown) => d),
}))

// jsdom's global Response.json() returns the raw body string and lacks .text().
// Install a faithful replacement (the route uses `new Response()` / `Response.json`).
class TestResponse {
  private _body: string
  status: number
  constructor(body?: string, init?: { status?: number }) {
    this._body = typeof body === 'string' ? body : ''
    this.status = init?.status ?? 200
  }
  async text() { return this._body }
  async json() { return JSON.parse(this._body || 'null') }
  static json(body: unknown, init?: { status?: number }) {
    return new TestResponse(JSON.stringify(body), init)
  }
}
;(global as unknown as { Response: unknown }).Response = TestResponse

import type { NextRequest } from 'next/server'
import { POST } from '../route'

const USER_ID = 1
const OWN_CONVO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

function req(body: unknown) {
  return { json: async () => body } as unknown as NextRequest
}

describe('POST /api/nexus/messages (REV-SEC-145 / REV-SEC-143)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'caller-sub' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: USER_ID } } })
    mockGetConversationById.mockResolvedValue({ id: OWN_CONVO, userId: USER_ID })
    mockUpsertMessageWithStats.mockResolvedValue({})
  })

  it('rejects an upsert whose messageId belongs to a different conversation (REV-SEC-145)', async () => {
    // The messageId already exists under a conversation the caller does NOT own.
    mockGetMessageById.mockResolvedValue({ id: 'msg-victim', conversationId: 'victim-convo' })

    const res = await POST(req({
      conversationId: OWN_CONVO, // owned by caller (passes the ownership gate)
      messageId: 'msg-victim',
      role: 'assistant',
      content: 'tampered',
    }))

    expect(res.status).toBe(409)
    // The victim's row is never overwritten.
    expect(mockUpsertMessageWithStats).not.toHaveBeenCalled()
  })

  it('allows the owner to update an existing message in their own conversation', async () => {
    mockGetMessageById.mockResolvedValue({ id: 'msg-own', conversationId: OWN_CONVO })

    const res = await POST(req({
      conversationId: OWN_CONVO,
      messageId: 'msg-own',
      role: 'assistant',
      content: 'edited',
    }))

    expect(res.status).toBe(200)
    expect(mockUpsertMessageWithStats).toHaveBeenCalledTimes(1)
  })

  it('strips client-supplied s3Key/imageUrl from parts before persisting (REV-SEC-143)', async () => {
    mockGetMessageById.mockResolvedValue(null) // new message

    await POST(req({
      conversationId: OWN_CONVO,
      messageId: 'msg-new',
      role: 'assistant',
      parts: [
        { type: 'image', imageUrl: 'https://evil/x', s3Key: '3/1699-secret.pdf', altText: 'a' },
        { type: 'text', text: 'hello' },
      ],
    }))

    expect(mockUpsertMessageWithStats).toHaveBeenCalledTimes(1)
    const persistedParts = (mockUpsertMessageWithStats.mock.calls[0][2] as { parts: Array<Record<string, unknown>> }).parts
    // Storage refs removed; other fields preserved.
    expect(persistedParts[0]).toEqual({ type: 'image', altText: 'a' })
    expect(persistedParts[0]).not.toHaveProperty('s3Key')
    expect(persistedParts[0]).not.toHaveProperty('imageUrl')
    expect(persistedParts[1]).toEqual({ type: 'text', text: 'hello' })
  })

  it('returns 404 when the caller does not own the conversation', async () => {
    mockGetConversationById.mockResolvedValue(null)

    const res = await POST(req({
      conversationId: 'someone-elses', messageId: 'm', role: 'user', content: 'x',
    }))

    expect(res.status).toBe(404)
    expect(mockGetMessageById).not.toHaveBeenCalled()
    expect(mockUpsertMessageWithStats).not.toHaveBeenCalled()
  })
})
