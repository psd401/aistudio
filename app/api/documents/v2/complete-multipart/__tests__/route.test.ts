/**
 * Tests for POST /api/documents/v2/complete-multipart S3 key correctness
 * (REV-COR-212).
 *
 * The route computed the processor key as `uploads/${jobId}/${inlineSanitized}` —
 * missing the `v2/` prefix that document-upload.ts stores objects under, and using
 * a second, inconsistent sanitization. Every multipart document therefore failed to
 * process. The fix uses the shared `sanitizeFileName` once and the `v2/uploads/`
 * prefix, so the completion/queue key matches what `generateMultipartUrls` created.
 */

const mockCompleteMultipartUpload = jest.fn()
jest.mock("@/lib/aws/document-upload", () => {
  const actual = jest.requireActual("@/lib/aws/document-upload")
  return {
    __esModule: true,
    ...actual,
    completeMultipartUpload: (...a: unknown[]) => mockCompleteMultipartUpload(...a),
  }
})

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockConfirmDocumentUpload = jest.fn()
const mockGetJobStatus = jest.fn()
jest.mock("@/lib/services/document-job-service", () => ({
  confirmDocumentUpload: (...a: unknown[]) => mockConfirmDocumentUpload(...a),
  getJobStatus: (...a: unknown[]) => mockGetJobStatus(...a),
}))

const mockSendToProcessingQueue = jest.fn()
jest.mock("@/lib/aws/lambda-trigger", () => ({
  sendToProcessingQueue: (...a: unknown[]) => mockSendToProcessingQueue(...a),
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

// Real sanitizeFileName — the same function generateMultipartUrls uses to build the
// create-time key, so the expected keys below reflect production behavior.
const { sanitizeFileName } = jest.requireActual("@/lib/aws/document-upload") as {
  sanitizeFileName: (f: string) => string
}

const JOB_ID = "33333333-3333-4333-8333-333333333333"

function req(body: unknown) {
  return { json: async () => body } as unknown as NextRequest
}

function bodyFor() {
  return { uploadId: "upload-1", jobId: JOB_ID, parts: [{ ETag: "etag-1", PartNumber: 1 }] }
}

describe("POST complete-multipart S3 key (REV-COR-212)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockCompleteMultipartUpload.mockResolvedValue(undefined)
    mockConfirmDocumentUpload.mockResolvedValue(undefined)
    mockSendToProcessingQueue.mockResolvedValue(undefined)
  })

  it.each([
    "report.pdf",
    "my report (final).pdf", // characters that diverge under inline-regex vs sanitizeFileName
  ])("queues the v2/uploads key produced by sanitizeFileName for %p", async (fileName) => {
    mockGetJobStatus.mockResolvedValue({
      fileName, fileSize: 123, fileType: "application/pdf", processingOptions: {},
    })

    const res = await POST(req(bodyFor()))
    expect(res.status).toBe(200)

    const expectedKey = `v2/uploads/${JOB_ID}/${sanitizeFileName(fileName)}`

    // The queue key has the v2/ prefix and single sanitization (matches create step).
    expect(mockSendToProcessingQueue).toHaveBeenCalledTimes(1)
    expect(mockSendToProcessingQueue.mock.calls[0][0].key).toBe(expectedKey)
    expect(mockSendToProcessingQueue.mock.calls[0][0].key.startsWith("v2/uploads/")).toBe(true)

    // The raw fileName is handed to completeMultipartUpload, which sanitizes
    // internally exactly once (matching generateMultipartUrls' own key derivation).
    // Passing an already-sanitized name here would cause completeMultipartUpload to
    // sanitize it a second time; sanitizeFileName is not idempotent (e.g. truncation
    // can leave a trailing underscore that a second pass strips), so double-applying
    // it can target a different S3 key than the one the upload was created under.
    expect(mockCompleteMultipartUpload).toHaveBeenCalledWith(
      JOB_ID, fileName, "upload-1", [{ ETag: "etag-1", PartNumber: 1 }]
    )
  })

  it("returns 401 without a session and never touches S3/queue", async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await POST(req(bodyFor()))
    expect(res.status).toBe(401)
    expect(mockCompleteMultipartUpload).not.toHaveBeenCalled()
    expect(mockSendToProcessingQueue).not.toHaveBeenCalled()
  })
})
