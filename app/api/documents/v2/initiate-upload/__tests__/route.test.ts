/**
 * Tests for POST /api/documents/v2/initiate-upload after switching to the shared
 * UploadRequestSchema (REV-REF-017).
 *
 * The route previously re-declared the upload validation schema inline; it now
 * imports the shared `UploadRequestSchema`. These tests confirm the shared schema's
 * validation rules still apply (identical 400 + message) and the happy path works,
 * proving the swap is behavior-preserving.
 */

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGeneratePresignedUrl = jest.fn()
const mockGenerateMultipartUrls = jest.fn()
jest.mock("@/lib/aws/document-upload", () => ({
  generatePresignedUrl: (...a: unknown[]) => mockGeneratePresignedUrl(...a),
  generateMultipartUrls: (...a: unknown[]) => mockGenerateMultipartUrls(...a),
}))

const mockCreateDocumentJob = jest.fn()
jest.mock("@/lib/services/document-job-service", () => ({
  createDocumentJob: (...a: unknown[]) => mockCreateDocumentJob(...a),
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

function req(body: unknown) {
  return { json: async () => body } as unknown as NextRequest
}

describe("POST initiate-upload shared schema (REV-REF-017)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockCreateDocumentJob.mockResolvedValue({ id: "job-1" })
    mockGeneratePresignedUrl.mockResolvedValue({ uploadId: "u1", url: "https://s3", method: "PUT" })
  })

  it("rejects generateEmbeddings on a >50MB file with the shared schema's 400 message", async () => {
    const res = await POST(req({
      fileName: "big.pdf",
      fileSize: 60 * 1024 * 1024,
      fileType: "application/pdf",
      purpose: "repository",
      processingOptions: { generateEmbeddings: true },
    }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe("Invalid request data")
    expect(JSON.stringify(body.details)).toContain(
      "Embedding generation is disabled for files over 50MB"
    )
    expect(mockCreateDocumentJob).not.toHaveBeenCalled()
  })

  it("accepts a valid small upload (single presigned URL path)", async () => {
    const res = await POST(req({
      fileName: "note.pdf",
      fileSize: 1024,
      fileType: "application/pdf",
      purpose: "chat",
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.jobId).toBe("job-1")
    expect(mockCreateDocumentJob).toHaveBeenCalledTimes(1)
  })
})
