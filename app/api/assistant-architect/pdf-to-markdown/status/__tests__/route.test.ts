/**
 * Tests for GET /api/assistant-architect/pdf-to-markdown/status ownership on the
 * replication-lag fallback (REV-SEC-104).
 *
 * The primary lookup is user-scoped, but on a miss the handler falls back to an
 * UNSCOPED `getGenericJobById`. Previously it returned that job's status to any
 * caller (IDOR). These tests lock in the fix: the fallback must re-verify
 * ownership, so another user's job id yields 404 while the caller's own
 * (replica-lagged) job still resolves.
 */

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

const mockGetGenericJobByIdForUser = jest.fn()
const mockGetGenericJobById = jest.fn()
jest.mock("@/lib/db/drizzle", () => ({
  getGenericJobByIdForUser: (...a: unknown[]) => mockGetGenericJobByIdForUser(...a),
  getGenericJobById: (...a: unknown[]) => mockGetGenericJobById(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  generateRequestId: jest.fn(() => "test-request-id"),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((d: unknown) => d),
}))

// next/jest exposes NextResponse as a non-constructable stub, and the jsdom
// Response global has no working `.text()`. The route uses `new NextResponse(...)`,
// so provide a self-contained replacement implementing status/text()/json().
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
    async text() {
      return this.body
    }
    async json() {
      return JSON.parse(this.body || "null")
    }
    static json(body: unknown, init?: Init) {
      return new MockNextResponse(JSON.stringify(body), init)
    }
  }
  return { __esModule: true, NextResponse: MockNextResponse, NextRequest: class {} }
})

import type { NextRequest } from "next/server"
import { GET } from "../route"

const CALLER_ID = 1

// The handler reads only `req.url`; a minimal stub avoids the next/jest partial
// Request polyfill that drops headers.
function req(jobId = "7") {
  return {
    url: `http://localhost/api/assistant-architect/pdf-to-markdown/status?jobId=${jobId}`,
    headers: { get: () => null },
  } as unknown as NextRequest
}

describe("GET pdf-to-markdown/status fallback ownership (REV-SEC-104)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: CALLER_ID } },
    })
  })

  it("returns 404 (not another user's status) when the fallback finds a job owned by someone else", async () => {
    // User-scoped lookup misses...
    mockGetGenericJobByIdForUser.mockResolvedValue(null)
    // ...but an unscoped job with that id exists, owned by a DIFFERENT user.
    mockGetGenericJobById.mockResolvedValue({ id: 7, userId: 999, status: "completed" })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe("Job not found")
    // The other user's status string must never be disclosed.
    expect(JSON.stringify(body)).not.toContain("completed")
  })

  it("still resolves the caller's own job on the replication-lag fallback path", async () => {
    // User-scoped lookup misses (simulated replica lag)...
    mockGetGenericJobByIdForUser.mockResolvedValue(null)
    // ...but the unscoped read finds the caller's OWN job.
    mockGetGenericJobById.mockResolvedValue({ id: 7, userId: CALLER_ID, status: "running" })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ jobId: 7, status: "running" })
  })

  it("returns 404 when neither lookup finds the job", async () => {
    mockGetGenericJobByIdForUser.mockResolvedValue(null)
    mockGetGenericJobById.mockResolvedValue(null)

    const res = await GET(req())

    expect(res.status).toBe(404)
  })
})
