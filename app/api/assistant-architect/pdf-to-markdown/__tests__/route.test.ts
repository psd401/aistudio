/**
 * Tests for POST /api/assistant-architect/pdf-to-markdown early size guard
 * (REV-COR-201).
 *
 * The route used a Pages-Router `export const config = { api: { bodyParser } }`
 * that App Router ignores, so oversized uploads were only rejected AFTER the whole
 * body had been buffered by `req.formData()`. The fix adds an early
 * `Content-Length` guard that returns 413 before buffering, while the authoritative
 * post-formData `file.size` check remains. These tests cover the early-rejection
 * path and confirm normally-sized requests still pass the guard.
 */

const mockGenerateCompletion = jest.fn()
jest.mock("@/lib/ai-helpers", () => ({
  generateCompletion: (...a: unknown[]) => mockGenerateCompletion(...a),
}))

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

const mockCreateGenericJob = jest.fn()
const mockGetGenericJobById = jest.fn()
const mockUpdateGenericJobStatus = jest.fn()
const mockGetAIModelById = jest.fn()
jest.mock("@/lib/db/drizzle", () => ({
  createGenericJob: (...a: unknown[]) => mockCreateGenericJob(...a),
  getGenericJobById: (...a: unknown[]) => mockGetGenericJobById(...a),
  updateGenericJobStatus: (...a: unknown[]) => mockUpdateGenericJobStatus(...a),
  getAIModelById: (...a: unknown[]) => mockGetAIModelById(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

const mockGetContentPlatformConfig = jest.fn()
const mockIsCanonicalRepositoryUploadActive = jest.fn()
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: (...a: unknown[]) =>
    mockGetContentPlatformConfig(...a),
  isCanonicalRepositoryUploadActive: (...a: unknown[]) =>
    mockIsCanonicalRepositoryUploadActive(...a),
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
import { POST } from "../route"

const MB = 1024 * 1024

// Minimal NextRequest stub — the handler reads only `req.headers.get(...)` and
// `req.formData()`. Avoids the next/jest partial Request polyfill that drops
// headers/body.
function makeReq(opts: { contentLength?: string; formData?: unknown }): NextRequest {
  const h = new Map<string, string>()
  if (opts.contentLength !== undefined) h.set("content-length", opts.contentLength)
  return {
    url: "http://localhost/api/assistant-architect/pdf-to-markdown",
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    formData: async () => opts.formData,
  } as unknown as NextRequest
}

describe("POST pdf-to-markdown early size guard (REV-COR-201)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: 1 } },
    })
    mockGetContentPlatformConfig.mockResolvedValue({})
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(false)
  })

  it("rejects new legacy jobs after canonical repository upload cutover", async () => {
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(true)
    const request = makeReq({
      contentLength: String(5 * MB),
      formData: undefined,
    })
    const formDataSpy = jest.spyOn(request, "formData")
    const res = await POST(request)

    const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.error).toContain("knowledge repository")
    expect(res.headers.get("Deprecation")).toBe("true")
    expect(formDataSpy).not.toHaveBeenCalled()
    expect(mockCreateGenericJob).not.toHaveBeenCalled()
  })

  it("rejects an oversized upload with 413 via Content-Length before buffering the body", async () => {
    const res = await POST(makeReq({ contentLength: String(26 * MB) }))
    const body = await res.json()

    expect(res.status).toBe(413)
    expect(body.error).toContain("25MB")
    // Guard fires before any body buffering or job creation.
    expect(mockCreateGenericJob).not.toHaveBeenCalled()
  })

  it("does not reject a normally-sized request at the Content-Length guard", async () => {
    // A small, non-PDF file passes the early guard and reaches the authoritative
    // file-type check (proving the guard is not over-broad).
    const fileStub = { name: "note.txt", type: "text/plain", size: 5 }
    const formDataStub = { get: (k: string) => (k === "file" ? fileStub : null) }

    const res = await POST(makeReq({ formData: formDataStub }))
    const body = await res.json()

    // Passed the 413 guard, then rejected by the PDF-type check — not 413.
    expect(res.status).toBe(400)
    expect(body.error).toContain("PDF")
    expect(mockCreateGenericJob).not.toHaveBeenCalled()
  })
})
