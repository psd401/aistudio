/**
 * Tests for GET /api/documents conversation-ownership authorization
 * (REV-SEC-122 / REV-COR-211).
 *
 * The `?conversationId=` branch returned every document (plus fresh 1-hour signed
 * S3 URLs) for a conversation without verifying the caller owned it — an IDOR
 * letting any authenticated user download another user's files. The fix adds a
 * `getConversationById(conversationId, userId)` ownership gate (404 on miss). These
 * tests lock that in and confirm the already-correct single-document branch is
 * unchanged.
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
const mockGetDocumentById = jest.fn()
const mockDeleteDocumentById = jest.fn()
jest.mock("@/lib/db/queries/documents", () => ({
  getDocumentsByConversationId: (...a: unknown[]) => mockGetDocumentsByConversationId(...a),
  getDocumentById: (...a: unknown[]) => mockGetDocumentById(...a),
  deleteDocumentById: (...a: unknown[]) => mockDeleteDocumentById(...a),
}))

const mockGetConversationById = jest.fn()
jest.mock("@/lib/db/drizzle/nexus-conversations", () => ({
  getConversationById: (...a: unknown[]) => mockGetConversationById(...a),
}))

const mockGetDocumentSignedUrl = jest.fn()
const mockDeleteDocument = jest.fn()
jest.mock("@/lib/aws/s3-client", () => ({
  getDocumentSignedUrl: (...a: unknown[]) => mockGetDocumentSignedUrl(...a),
  deleteDocument: (...a: unknown[]) => mockDeleteDocument(...a),
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
import { GET } from "../route"

const CALLER_ID = 1
const CONVO = "11111111-1111-4111-8111-111111111111"

function req(params: Record<string, string>) {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest
}

describe("GET /api/documents ownership (REV-SEC-122 / REV-COR-211)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: CALLER_ID } } })
    mockGetDocumentSignedUrl.mockResolvedValue("https://s3.example/signed-url")
  })

  it("returns 404 and no documents/URLs for a conversation the caller does not own", async () => {
    mockGetConversationById.mockResolvedValue(null) // not owned by caller

    const res = await GET(req({ conversationId: CONVO }))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body).toEqual({ success: false, error: "Conversation not found" })
    // No document listing and no signed S3 URLs for a non-owned conversation.
    expect(mockGetDocumentsByConversationId).not.toHaveBeenCalled()
    expect(mockGetDocumentSignedUrl).not.toHaveBeenCalled()
    expect(mockGetConversationById).toHaveBeenCalledWith(CONVO, CALLER_ID)
  })

  it("returns the owner's documents with fresh signed URLs", async () => {
    mockGetConversationById.mockResolvedValue({ id: CONVO, userId: CALLER_ID })
    mockGetDocumentsByConversationId.mockResolvedValue([{ id: 7, url: "s3-key-7", name: "a.pdf" }])

    const res = await GET(req({ conversationId: CONVO }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.documents).toHaveLength(1)
    expect(body.documents[0].url).toBe("https://s3.example/signed-url")
    expect(mockGetDocumentSignedUrl).toHaveBeenCalledWith({ key: "s3-key-7", expiresIn: 3600 })
  })

  it("rejects an invalid conversation UUID with 400 before any ownership lookup", async () => {
    const res = await GET(req({ conversationId: "not-a-uuid" }))
    expect(res.status).toBe(400)
    expect(mockGetConversationById).not.toHaveBeenCalled()
  })

  // --- single-document branch must be unchanged by this fix ---

  it("still returns 403 for another user's document via the id branch", async () => {
    mockGetDocumentById.mockResolvedValue({ id: 5, userId: 999, url: "s3-key-5" })

    const res = await GET(req({ id: "5" }))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe("Unauthorized access to document")
    expect(mockGetDocumentSignedUrl).not.toHaveBeenCalled()
  })

  it("still returns the owner's own document via the id branch", async () => {
    mockGetDocumentById.mockResolvedValue({ id: 5, userId: CALLER_ID, url: "s3-key-5", name: "a.pdf" })

    const res = await GET(req({ id: "5" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.document.url).toBe("https://s3.example/signed-url")
  })
})
