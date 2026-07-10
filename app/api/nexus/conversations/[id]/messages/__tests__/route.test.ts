/**
 * Tests for GET /api/nexus/conversations/[id]/messages presign gate (REV-SEC-143).
 *
 * The route regenerates a presigned S3 GET URL for image parts carrying an s3Key.
 * Because that s3Key ultimately originates from client-supplied parts, only keys
 * that belong to THIS conversation (its attachment prefix or its generated-image
 * prefix) may be signed — a planted key pointing at another user's object must
 * never be presigned.
 */

const mockGetServerSession = jest.fn()
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock('@/actions/db/get-current-user-action', () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

const mockGetMessagesByConversation = jest.fn()
const mockGetMessageCount = jest.fn()
const mockGetConversationById = jest.fn()
jest.mock('@/lib/db/drizzle', () => ({
  getMessagesByConversation: (...a: unknown[]) => mockGetMessagesByConversation(...a),
  getMessageCount: (...a: unknown[]) => mockGetMessageCount(...a),
  getConversationById: (...a: unknown[]) => mockGetConversationById(...a),
  DEFAULT_MESSAGE_LIMIT: 50,
  MAX_MESSAGE_LIMIT: 100,
}))

const mockGetDocumentSignedUrl = jest.fn()
jest.mock('@/lib/aws/s3-client', () => ({
  getDocumentSignedUrl: (...a: unknown[]) => mockGetDocumentSignedUrl(...a),
}))

jest.mock('@/lib/utils/text-sanitizer', () => ({
  decodeHtmlEntitiesDeep: (v: unknown) => v,
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
}))

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
import { GET } from '../route'

const CONVO = 'cccccccc-1111-4111-8111-cccccccccccc'

function req() {
  return { url: `http://localhost/api/nexus/conversations/${CONVO}/messages` } as unknown as NextRequest
}
function ctx() {
  return { params: Promise.resolve({ id: CONVO }) }
}

function imageMessage(s3Key: string) {
  return [{
    id: 'm1',
    role: 'assistant',
    content: null,
    parts: [{ type: 'image', s3Key }],
    createdAt: new Date(),
    metadata: null,
  }]
}

describe('GET conversations/[id]/messages presign gate (REV-SEC-143)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: 'caller-sub' })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockGetConversationById.mockResolvedValue({ id: CONVO, title: 'T', modelUsed: null })
    mockGetMessageCount.mockResolvedValue(1)
    mockGetDocumentSignedUrl.mockResolvedValue('https://s3.example/SIGNED')
  })

  it('never presigns an s3Key outside the conversation prefix', async () => {
    // Planted key pointing at another user's uploaded document.
    mockGetMessagesByConversation.mockResolvedValue(imageMessage('3/1699999999-secret.pdf'))

    const res = await GET(req(), ctx())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockGetDocumentSignedUrl).not.toHaveBeenCalled()
    // No presigned URL leaked into the response.
    expect(JSON.stringify(body)).not.toContain('SIGNED')
  })

  it('presigns a key that belongs to this conversation (attachment prefix)', async () => {
    const key = `conversations/${CONVO}/attachments/m1-0-ref.png`
    mockGetMessagesByConversation.mockResolvedValue(imageMessage(key))

    const res = await GET(req(), ctx())
    const body = await res.json()

    expect(mockGetDocumentSignedUrl).toHaveBeenCalledWith({ key, expiresIn: 3600 })
    expect(JSON.stringify(body)).toContain('SIGNED')
  })

  it('presigns a key under this conversation generated-images prefix', async () => {
    const key = `v2/generated-images/${CONVO}/123-model.png`
    mockGetMessagesByConversation.mockResolvedValue(imageMessage(key))

    await GET(req(), ctx())

    expect(mockGetDocumentSignedUrl).toHaveBeenCalledWith({ key, expiresIn: 3600 })
  })

  it('returns 404 when the caller does not own the conversation', async () => {
    mockGetConversationById.mockResolvedValue(null)

    const res = await GET(req(), ctx())

    expect(res.status).toBe(404)
    expect(mockGetMessagesByConversation).not.toHaveBeenCalled()
  })
})
