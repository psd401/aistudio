import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Mocks
// ============================================

/* eslint-disable no-var */
var mockCaptureStructuredDecision = jest.fn()
/* eslint-enable no-var */

// Keep the REAL Zod schema + describeDecisionError (validation + friendly-error
// behavior is what we're testing); stub only the DB-touching capture function.
jest.mock("@/lib/graph/decision-capture-service", () => {
  const actual = jest.requireActual("@/lib/graph/decision-capture-service")
  return {
    __esModule: true,
    ...actual,
    captureStructuredDecision: (...args: unknown[]) => mockCaptureStructuredDecision(...args),
  }
})

// The translator is pulled in transitively by the service module; stub it so the
// heavy AI-provider imports never load for this handler test.
jest.mock("@/lib/graph/decision-api-translator", () => ({
  __esModule: true,
  translatePayloadToGraph: jest.fn(),
  computeLlmScore: jest.fn(),
}))

// Heavy sibling modules imported by tool-handlers.ts but unused by capture_decision.
jest.mock("@/lib/api/assistant-execution-service", () => ({
  __esModule: true,
  executeAssistantForJobCompletion: jest.fn(),
  validateExecutionInputs: jest.fn(),
}))
jest.mock("@/lib/api/assistant-service", () => ({
  __esModule: true,
  listAccessibleAssistants: jest.fn(),
}))
jest.mock("@/lib/api/route-helpers", () => ({
  __esModule: true,
  isAdminByUserId: jest.fn(),
  checkAssistantResourceGrants: jest.fn(),
}))
jest.mock("@/actions/db/assistant-architect-actions", () => ({
  __esModule: true,
  getAssistantArchitectByIdAction: jest.fn(),
}))
jest.mock("@/lib/agents/agent-tools", () => ({
  __esModule: true,
  AGENT_TOOL_HANDLERS: {},
}))
jest.mock("@/lib/mcp/content-tool-handlers", () => ({
  __esModule: true,
  CONTENT_TOOL_HANDLERS: {},
}))
jest.mock("@/lib/capabilities/capability-catalog", () => ({
  __esModule: true,
  buildCapabilityCatalog: jest.fn(() => ({})),
}))

import { TOOL_HANDLERS } from "@/lib/mcp/tool-handlers"

const CONTEXT = { userId: 7, cognitoSub: "sub", scopes: ["graph:write"], requestId: "req-1" }

function callCapture(args: Record<string, unknown>) {
  return TOOL_HANDLERS.capture_decision(args, CONTEXT)
}

// ============================================
// handleCaptureDecision
// ============================================

describe("handleCaptureDecision (MCP)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns isError with field details for an invalid payload", async () => {
    const result = await callCapture({ decidedBy: "Team" }) // missing decision

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Validation failed")
    expect(mockCaptureStructuredDecision).not.toHaveBeenCalled()
  })

  it("returns the capture result on success", async () => {
    mockCaptureStructuredDecision.mockResolvedValue({
      decisionNodeId: "node-1",
      nodesCreated: 3,
      edgesCreated: 2,
      completenessScore: 75,
      completenessMethod: "rule-based",
      warnings: ["No conditions"],
    })

    const result = await callCapture({ decision: "Adopt PG", decidedBy: "Team" })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text ?? "")
    expect(payload).toMatchObject({
      decisionNodeId: "node-1",
      nodesCreated: 3,
      edgesCreated: 2,
      completenessScore: 75,
      completenessMethod: "rule-based",
      warnings: ["No conditions"],
    })
  })

  it("surfaces the friendly field message when the service throws a validation error", async () => {
    // ErrorFactories.validationFailed produces a typed VALIDATION_FAILED error.
    const { ErrorFactories } = jest.requireActual("@/lib/error-utils")
    mockCaptureStructuredDecision.mockRejectedValue(
      ErrorFactories.validationFailed([{ field: "edges", message: "A node cannot connect to itself" }])
    )

    const result = await callCapture({ decision: "D", decidedBy: "P" })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("A node cannot connect to itself")
    // Never leaks the generic "Validation failed for N field(s)" wrapper alone.
    expect(result.content[0].text).toContain("Validation error:")
  })

  it("returns a generic message for a non-validation failure (no internal detail leaks)", async () => {
    mockCaptureStructuredDecision.mockRejectedValue(new Error("Connection lost to db.internal:5432"))

    const result = await callCapture({ decision: "D", decidedBy: "P" })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Failed to capture decision")
    // Raw error text (connection strings, constraint names) must never surface.
    expect(result.content[0].text).not.toContain("Connection lost")
    expect(result.content[0].text).not.toContain("db.internal")
  })
})
