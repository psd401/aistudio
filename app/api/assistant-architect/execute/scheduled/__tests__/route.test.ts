/**
 * Tests for POST /api/assistant-architect/execute/scheduled JWT<->body binding &
 * replay protection (REV-SEC-101 / REV-COR-200).
 *
 * The route authenticates with an internal HMAC JWT carrying { scheduleId,
 * executionId } but historically took userId/toolId/scheduleId from the request
 * BODY without cross-checking them against the JWT or the schedule, and had no
 * replay guard. A captured/replayed token could therefore run an arbitrary tool as
 * an arbitrary user and overwrite another schedule's execution_results row.
 *
 * The fix derives/validates identity server-side:
 *   (a) body.scheduleId must equal the JWT scheduleId,
 *   (b) the execution_results row (from the JWT) must belong to that schedule and
 *       be unconsumed (single-use replay guard),
 *   (c) the schedule's userId/toolId must match the body.
 * Plus: internal tokens without an `exp` claim are rejected.
 *
 * Every check below rejects BEFORE any execution, so no streaming pipeline is
 * exercised — the assertions confirm the privileged work never starts.
 */

const mockJwtVerify = jest.fn()
jest.mock("jsonwebtoken", () => ({
  __esModule: true,
  default: { verify: (...a: unknown[]) => mockJwtVerify(...a) },
  verify: (...a: unknown[]) => mockJwtVerify(...a),
}))

let execResultRows: unknown[] = []
let scheduleRows: unknown[] = []
const mockExecuteQuery = jest.fn(
  async (_fn: unknown, op: string) => {
    if (op === "loadExecutionResultForAuth") return execResultRows
    if (op === "loadScheduleForAuth") return scheduleRows
    return []
  }
)
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (fn: unknown, op: string) => mockExecuteQuery(fn, op),
  toPgRows: (r: unknown) => r,
}))

const mockGetUserById = jest.fn()
const mockGetAssistantArchitectById = jest.fn()
const mockGetChainPrompts = jest.fn()
const mockGetAIModelById = jest.fn()
jest.mock("@/lib/db/drizzle", () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
  getAssistantArchitectById: (...a: unknown[]) => mockGetAssistantArchitectById(...a),
  getChainPrompts: (...a: unknown[]) => mockGetChainPrompts(...a),
  getAIModelById: (...a: unknown[]) => mockGetAIModelById(...a),
}))

jest.mock("@/lib/streaming/unified-streaming-service", () => ({
  unifiedStreamingService: { stream: jest.fn() },
}))
jest.mock("@/lib/assistant-architect/knowledge-retrieval", () => ({
  retrieveKnowledgeForPrompt: jest.fn(),
  formatKnowledgeContext: jest.fn(() => ""),
}))
jest.mock("@/lib/tools/repository-tools", () => ({
  createRepositoryTools: jest.fn(() => ({})),
}))
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}))
jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: new Proxy(
    {},
    { get: () => (...a: unknown[]) => new Error(`mock-error:${JSON.stringify(a)}`) }
  ),
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

// The route's `@/lib/db/schema` import transitively reaches the Atrium
// markdown-render pipeline, which imports the pure-ESM unified/remark/rehype
// ecosystem next/jest (SWC) cannot transform (see jest.config.js). Mock it
// directly, matching the established pattern (e.g. tests/unit/atrium-rollback.test.ts).
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}))

import type { NextRequest } from "next/server"
import { POST } from "../route"

// The route builds responses with the global `Response`. jsdom's polyfill returns
// the raw body string from `.json()` (so `body.error` would be undefined) and lacks
// `.text()`. Install a faithful replacement — the route reads the global at call
// time, so assigning here (before any test runs) is sufficient.
class TestResponse {
  private _body: string
  status: number
  headers: { get: (k: string) => string | null }
  constructor(body?: string, init?: { status?: number; headers?: Record<string, string> }) {
    this._body = typeof body === "string" ? body : ""
    this.status = init?.status ?? 200
    const h = init?.headers ?? {}
    this.headers = { get: (k: string) => h[k] ?? h[k.toLowerCase()] ?? null }
  }
  async text() {
    return this._body
  }
  async json() {
    return JSON.parse(this._body || "null")
  }
}
;(global as unknown as { Response: unknown }).Response = TestResponse

const FUTURE_EXP = 9_999_999_999

// Minimal NextRequest stub — the handler reads only `req.headers.get('authorization')`
// and `req.json()`. Avoids the next/jest partial Request polyfill that drops headers.
function buildReq(body: unknown, auth: string | null = "Bearer internal-token"): NextRequest {
  const h = new Map<string, string>()
  if (auth) h.set("authorization", auth)
  return {
    url: "http://localhost/api/assistant-architect/execute/scheduled",
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as NextRequest
}

const validBody = {
  scheduleId: 1,
  toolId: 5,
  inputs: {},
  userId: 7,
  triggeredBy: "manual" as const,
  scheduledAt: "2026-01-01T00:00:00Z",
}

describe("POST execute/scheduled binding & replay (REV-SEC-101 / REV-COR-200)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.INTERNAL_API_SECRET = "test-secret"
    execResultRows = []
    scheduleRows = []
    mockGetUserById.mockResolvedValue({ cognitoSub: "owner-sub" })
  })

  it("rejects an internal token with no `exp` claim (replay hardening)", async () => {
    // Missing exp — jwt.verify only enforces expiry when present.
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100" })

    const res = await POST(buildReq(validBody))

    expect(res.status).toBe(401)
    // Rejected during auth, before any DB lookup or execution.
    expect(mockExecuteQuery).not.toHaveBeenCalled()
    expect(mockGetUserById).not.toHaveBeenCalled()
  })

  it("rejects when body.scheduleId does not match the JWT scheduleId", async () => {
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100", exp: FUTURE_EXP })

    // Valid token for schedule 1, body claims schedule 2.
    const res = await POST(buildReq({ ...validBody, scheduleId: 2 }))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe("Forbidden")
    // Rejected before touching the database or running the tool.
    expect(mockExecuteQuery).not.toHaveBeenCalled()
    expect(mockGetUserById).not.toHaveBeenCalled()
  })

  it("rejects when the execution_results row belongs to a different schedule", async () => {
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100", exp: FUTURE_EXP })
    execResultRows = [{ scheduledExecutionId: 2, status: "pending" }]

    const res = await POST(buildReq(validBody))

    expect(res.status).toBe(403)
    expect(mockGetUserById).not.toHaveBeenCalled()
  })

  it("rejects a replayed token whose execution_results row is already consumed", async () => {
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100", exp: FUTURE_EXP })
    execResultRows = [{ scheduledExecutionId: 1, status: "completed" }]

    const res = await POST(buildReq(validBody))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toBe("Already processed")
    expect(mockGetUserById).not.toHaveBeenCalled()
  })

  it("rejects when body userId/toolId do not match the schedule (arbitrary-user execution blocked)", async () => {
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100", exp: FUTURE_EXP })
    execResultRows = [{ scheduledExecutionId: 1, status: "pending" }]
    // Schedule 1 is really owned by user 999 / tool 888, but the body claims user 7 / tool 5.
    scheduleRows = [{ userId: 999, assistantArchitectId: 888 }]

    const res = await POST(buildReq(validBody))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe("Forbidden")
    // The privileged execution (getUserById -> cognito sub -> prompt chain) never starts.
    expect(mockGetUserById).not.toHaveBeenCalled()
  })

  it("returns 404 when the authenticated schedule does not exist", async () => {
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100", exp: FUTURE_EXP })
    execResultRows = [{ scheduledExecutionId: 1, status: "pending" }]
    scheduleRows = []

    const res = await POST(buildReq(validBody))

    expect(res.status).toBe(404)
    expect(mockGetUserById).not.toHaveBeenCalled()
  })

  it("returns 401 when the Authorization header is missing", async () => {
    mockJwtVerify.mockReturnValue({ scheduleId: "1", executionId: "100", exp: FUTURE_EXP })

    const res = await POST(buildReq(validBody, ""))

    expect(res.status).toBe(401)
    expect(mockJwtVerify).not.toHaveBeenCalled()
  })
})
