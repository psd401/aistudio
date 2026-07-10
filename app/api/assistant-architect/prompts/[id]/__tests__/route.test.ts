/**
 * Tests for GET /api/assistant-architect/prompts/[id] authorization (REV-SEC-102).
 *
 * The route previously authenticated the caller but performed NO authorization:
 * any authenticated user could read any chain prompt by primary key (IDOR),
 * exposing every architect's `content`/`systemContext`. These tests lock in the
 * fix: require the `assistant-architect` capability AND access to the parent
 * architect (owner OR admin OR approved), returning 404 (not 403) so unauthorized
 * prompt ids are not enumerable.
 */

const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

const mockGetChainPromptById = jest.fn()
const mockGetAssistantArchitectById = jest.fn()
const mockGetAIModelById = jest.fn()
const mockGetActiveAIModels = jest.fn()
jest.mock("@/lib/db/drizzle", () => ({
  getChainPromptById: (...a: unknown[]) => mockGetChainPromptById(...a),
  getAssistantArchitectById: (...a: unknown[]) => mockGetAssistantArchitectById(...a),
  getAIModelById: (...a: unknown[]) => mockGetAIModelById(...a),
  getActiveAIModels: (...a: unknown[]) => mockGetActiveAIModels(...a),
}))

const mockHasCapabilityAccess = jest.fn()
const mockHasRole = jest.fn()
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...a: unknown[]) => mockHasCapabilityAccess(...a),
  hasRole: (...a: unknown[]) => mockHasRole(...a),
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
// Response global has no working `.text()`. The route uses both
// `new NextResponse(...)` and `NextResponse.json(...)`, so provide a self-contained
// replacement that implements status/text()/json() directly.
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

// The handler never reads `req` (it uses `params`); a minimal stub avoids the
// next/jest partial Request polyfill that drops headers.
function req() {
  return {
    url: "http://localhost/api/assistant-architect/prompts/5",
    headers: { get: () => null },
  } as unknown as NextRequest
}
function ctx(id = "5") {
  return { params: Promise.resolve({ id }) }
}

describe("GET /api/assistant-architect/prompts/[id] authorization (REV-SEC-102)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "caller-sub" })
    mockGetChainPromptById.mockResolvedValue({
      id: 5,
      assistantArchitectId: 42,
      name: "P",
      content: "SECRET-PROMPT-CONTENT",
      systemContext: "SECRET-SYSTEM-CONTEXT",
      modelId: null,
      position: 0,
      inputMapping: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: CALLER_ID } },
    })
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockHasRole.mockResolvedValue(false)
    mockGetActiveAIModels.mockResolvedValue([{ modelId: "default-model" }])
    mockGetAIModelById.mockResolvedValue({ modelId: "gpt-4" })
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await GET(req(), ctx())
    expect(res.status).toBe(401)
    expect(mockGetChainPromptById).not.toHaveBeenCalled()
  })

  it("returns 404 with no prompt fields when caller is not owner/admin and architect is not approved (IDOR)", async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 42, userId: 999, status: "pending" })

    const res = await GET(req(), ctx())
    const text = await res.text()

    expect(res.status).toBe(404)
    // The whole point of REV-SEC-102: no prompt content leaks to an unauthorized caller.
    expect(text).not.toContain("SECRET-PROMPT-CONTENT")
    expect(text).not.toContain("SECRET-SYSTEM-CONTEXT")
  })

  it("denies (404) and short-circuits when caller lacks the assistant-architect capability", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false)
    // Even an approved architect must not be reachable without the capability.
    mockGetAssistantArchitectById.mockResolvedValue({ id: 42, userId: 999, status: "approved" })

    const res = await GET(req(), ctx())

    expect(res.status).toBe(404)
    // Capability gate runs before the parent-architect lookup.
    expect(mockGetAssistantArchitectById).not.toHaveBeenCalled()
  })

  it("returns 404 when the prompt has no parent architect", async () => {
    mockGetChainPromptById.mockResolvedValue({
      id: 5,
      assistantArchitectId: null,
      name: "orphan",
      content: "SECRET-PROMPT-CONTENT",
      systemContext: null,
      modelId: null,
      position: 0,
      inputMapping: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await GET(req(), ctx())
    const text = await res.text()

    expect(res.status).toBe(404)
    expect(text).not.toContain("SECRET-PROMPT-CONTENT")
    expect(mockGetAssistantArchitectById).not.toHaveBeenCalled()
  })

  it("allows the architect owner to read the prompt", async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 42, userId: CALLER_ID, status: "pending" })

    const res = await GET(req(), ctx())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.content).toBe("SECRET-PROMPT-CONTENT")
  })

  it("allows an administrator to read any prompt", async () => {
    mockHasRole.mockResolvedValue(true)
    mockGetAssistantArchitectById.mockResolvedValue({ id: 42, userId: 999, status: "pending" })

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    expect(mockHasRole).toHaveBeenCalledWith("administrator")
  })

  it("allows reading a prompt whose parent architect is approved", async () => {
    mockGetAssistantArchitectById.mockResolvedValue({ id: 42, userId: 999, status: "approved" })

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
  })
})
