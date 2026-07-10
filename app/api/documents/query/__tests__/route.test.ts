/**
 * Tests for POST /api/documents/query (REV-SEC-121 ownership IDOR + REV-COR-208
 * error-message leak).
 *
 * SEC-121: the route returned the full extracted text of ANY conversation's
 * documents given its UUID, with no ownership check. The fix adds
 * `getConversationById(conversationId, userId)` (404 on miss) before reading chunks.
 * COR-208: the 500 path echoed raw `error.message`; it now returns a fixed generic
 * message while still logging the detail server-side.
 */

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

const mockGetDocumentsByConversationId = jest.fn()
const mockGetDocumentChunksByDocumentId = jest.fn()
jest.mock("@/lib/db/queries/documents", () => ({
  getDocumentsByConversationId: (...a: unknown[]) => mockGetDocumentsByConversationId(...a),
  getDocumentChunksByDocumentId: (...a: unknown[]) => mockGetDocumentChunksByDocumentId(...a),
}))

const mockGetConversationById = jest.fn()
jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  getConversationById: (...a: unknown[]) => mockGetConversationById(...a),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
  generateRequestId: jest.fn(() => "test-request-id"),
  startTimer: jest.fn(() => jest.fn()),
}))

jest.mock("next/server", () => {
  type Init = { status?: number; headers?: Record<string, string> }
  class MockNextResponse {
    body: string
    status: number
    headers: { get: (k: string) => string | null }
    constructor(body?: string, init?: Init) {
      this.body = typeof body === "string" ? body : ""
      this.status = init?.status ?? 200
      const h = init?.headers ?? {}
      this.headers = { get: (k: string) => h[k] ?? h[k.toLowerCase()] ?? null }
    }
    async text() { return this.body }
    async json() { return JSON.parse(this.body || "null") }
    static json(body: unknown, init?: Init) {
      return new MockNextResponse(JSON.stringify(body), init)
    }
  }
  return { __esModule: true, NextResponse: MockNextResponse, NextRequest: class {} }
})

import type { NextRequest } from "next/server"
import { POST } from "../route"

const CALLER_ID = 1
const CONVO = "22222222-2222-4222-8222-222222222222"

function req(body: unknown) {
  return { json: async () => body } as unknown as NextRequest
}

describe("POST /api/documents/query (REV-SEC-121 / REV-COR-208)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: CALLER_ID } } })
  })

  it("returns 404 and no chunk content for a conversation the caller does not own", async () => {
    mockGetConversationById.mockResolvedValue(null)

    const res = await POST(req({ conversationId: CONVO, query: "secret" }))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body).toEqual({ error: "Conversation not found" })
    // Never reaches the document/chunk reads for a non-owned conversation.
    expect(mockGetDocumentsByConversationId).not.toHaveBeenCalled()
    expect(mockGetConversationById).toHaveBeenCalledWith(CONVO, CALLER_ID)
  })

  it("returns search results for the conversation owner", async () => {
    mockGetConversationById.mockResolvedValue({ id: CONVO, userId: CALLER_ID })
    mockGetDocumentsByConversationId.mockResolvedValue([{ id: 3, name: "doc.pdf" }])
    mockGetDocumentChunksByDocumentId.mockResolvedValue([
      { documentId: 3, chunkIndex: 0, content: "the answer is 42" },
    ])

    const res = await POST(req({ conversationId: CONVO, query: "answer" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.results[0].content).toBe("the answer is 42")
  })

  it("returns a generic 500 message and never echoes raw error detail (REV-COR-208)", async () => {
    mockGetConversationById.mockRejectedValue(new Error("SECRET: relation \"documents\" pg detail"))

    const res = await POST(req({ conversationId: CONVO, query: "x" }))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toEqual({ error: "Failed to query documents" })
    expect(JSON.stringify(body)).not.toContain("SECRET")
    expect(JSON.stringify(body)).not.toContain("relation")
  })
})
