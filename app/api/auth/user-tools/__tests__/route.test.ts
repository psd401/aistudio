/**
 * Tests for GET /api/auth/user-tools error handling (REV-COR-208).
 *
 * The 500 path returned raw `error.message` to the client; it now returns a fixed
 * generic message while still logging the full error server-side.
 */

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGetUserCapabilities = jest.fn()
jest.mock("@/utils/roles", () => ({
  getUserCapabilities: (...a: unknown[]) => mockGetUserCapabilities(...a),
}))

const mockLogError = jest.fn()
jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => mockLogError(...a), debug: jest.fn(),
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

import { GET } from "../route"

describe("GET /api/auth/user-tools error handling (REV-COR-208)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
  })

  it("returns a generic 500 message and never echoes raw error detail", async () => {
    mockGetUserCapabilities.mockRejectedValue(new Error("SECRET: internal capability table blew up"))

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toEqual({ isSuccess: false, message: "Failed to fetch user tools" })
    expect(JSON.stringify(body)).not.toContain("SECRET")
    // The full error is still logged server-side for diagnosis.
    expect(mockLogError).toHaveBeenCalled()
  })
})
