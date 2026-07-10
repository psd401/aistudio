/**
 * Tests for POST /api/documents/upload (REV-COR-213 / REV-SEC-126 early size guard
 * + REV-COR-214 orphan cleanup).
 *
 * - The dead Pages-Router `config.api.bodyParser` enforced no cap; an early
 *   Content-Length guard now rejects oversized uploads with 413 before the body is
 *   buffered (the authoritative `file.size` check remains).
 * - A failure after the S3 upload previously orphaned the S3 object (and, on chunk
 *   failure, the documents row). The route now best-effort deletes them.
 */

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))

const mockGetCurrentUserAction = jest.fn()
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: (...a: unknown[]) => mockGetCurrentUserAction(...a),
}))

const mockGetMaxFileSize = jest.fn()
jest.mock("@/lib/file-validation", () => ({
  ALLOWED_FILE_EXTENSIONS: [".pdf"],
  ALLOWED_MIME_TYPES: ["application/pdf"],
  getMaxFileSize: (...a: unknown[]) => mockGetMaxFileSize(...a),
}))

const mockUploadDocument = jest.fn()
const mockDeleteDocument = jest.fn()
jest.mock("@/lib/aws/s3-client", () => ({
  uploadDocument: (...a: unknown[]) => mockUploadDocument(...a),
  deleteDocument: (...a: unknown[]) => mockDeleteDocument(...a),
}))

const mockSaveDocument = jest.fn()
const mockBatchInsertDocumentChunks = jest.fn()
const mockDeleteDocumentById = jest.fn()
jest.mock("@/lib/db/queries/documents", () => ({
  saveDocument: (...a: unknown[]) => mockSaveDocument(...a),
  batchInsertDocumentChunks: (...a: unknown[]) => mockBatchInsertDocumentChunks(...a),
  deleteDocumentById: (...a: unknown[]) => mockDeleteDocumentById(...a),
}))

const mockExtractTextFromDocument = jest.fn()
const mockChunkText = jest.fn()
const mockGetFileTypeFromFileName = jest.fn()
jest.mock("@/lib/document-processing", () => ({
  extractTextFromDocument: (...a: unknown[]) => mockExtractTextFromDocument(...a),
  chunkText: (...a: unknown[]) => mockChunkText(...a),
  getFileTypeFromFileName: (...a: unknown[]) => mockGetFileTypeFromFileName(...a),
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

const MB = 1024 * 1024

const fileStub = {
  name: "doc.pdf",
  type: "application/pdf",
  size: 1000,
  arrayBuffer: async () => new ArrayBuffer(10),
}

function makeReq(opts: { contentLength?: string; file?: unknown } = {}): NextRequest {
  const h = new Map<string, string>()
  if (opts.contentLength !== undefined) h.set("content-length", opts.contentLength)
  const file = "file" in opts ? opts.file : fileStub
  return {
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    formData: async () => ({ get: (k: string) => (k === "file" ? file : null) }),
  } as unknown as NextRequest
}

describe("POST /api/documents/upload (REV-COR-213 / REV-SEC-126 / REV-COR-214)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockGetCurrentUserAction.mockResolvedValue({ isSuccess: true, data: { user: { id: 1 } } })
    mockGetMaxFileSize.mockResolvedValue(25 * MB)
    mockGetFileTypeFromFileName.mockReturnValue("pdf")
    mockUploadDocument.mockResolvedValue({ url: "https://signed", key: "s3-key-abc" })
    mockExtractTextFromDocument.mockResolvedValue({ text: "hello world", metadata: {} })
    mockSaveDocument.mockResolvedValue({ id: 42, name: "doc.pdf", type: "pdf", size: 1000, url: "s3-key-abc" })
    mockChunkText.mockReturnValue(["chunk-a"])
    mockBatchInsertDocumentChunks.mockResolvedValue([{ id: 1 }])
  })

  it("rejects an oversized upload with 413 via Content-Length before buffering (REV-COR-213/126)", async () => {
    const res = await POST(makeReq({ contentLength: String(100 * MB) }))
    const body = await res.json()

    expect(res.status).toBe(413)
    expect(body.error).toContain("MB")
    // Guard fires before form parsing / S3 upload.
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it("succeeds for a normally-sized upload", async () => {
    const res = await POST(makeReq({ contentLength: String(1 * MB) }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.document.id).toBe(42)
  })

  it("deletes the orphaned S3 object when text extraction fails (REV-COR-214)", async () => {
    mockExtractTextFromDocument.mockRejectedValue(new Error("extract boom"))

    const res = await POST(makeReq())

    expect(res.status).toBe(500)
    expect(mockDeleteDocument).toHaveBeenCalledWith("s3-key-abc")
    // Never got to persisting the document row.
    expect(mockSaveDocument).not.toHaveBeenCalled()
    expect(mockDeleteDocumentById).not.toHaveBeenCalled()
  })

  it("rolls back both the documents row and the S3 object when chunk insert fails (REV-COR-214)", async () => {
    mockBatchInsertDocumentChunks.mockRejectedValue(new Error("chunk boom"))

    const res = await POST(makeReq())

    expect(res.status).toBe(500)
    // Document row removed, then S3 object removed — no orphans.
    expect(mockDeleteDocumentById).toHaveBeenCalledWith({ id: 42 })
    expect(mockDeleteDocument).toHaveBeenCalledWith("s3-key-abc")
  })
})
