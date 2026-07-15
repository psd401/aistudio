/**
 * Per-resource grant enforcement on the MCP execute_assistant handler (#1223,
 * closing the gap Codex flagged on PR #1231): REST execution verifies
 * assistant/model grants (#1206) at the route, so the MCP surface must enforce
 * the SAME gate — otherwise a staff key holding mcp:execute_assistant could run
 * a restricted assistant the identical REST call would 403.
 *
 * The real tool-handlers module runs; its service dependencies are mocked. The
 * grant decision itself is mocked (checkAssistantResourceGrants) — its internal
 * semantics (admin bypass, zero-grants-unrestricted) live in the SQL primitives
 * and are exercised elsewhere.
 */

import { describe, it, expect, beforeEach } from "@jest/globals"

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("@/lib/graph/graph-service", () => ({
  queryGraphNodes: jest.fn(),
  queryGraphNode: jest.fn(),
  queryNodeConnections: jest.fn(),
}))

jest.mock("@/lib/graph/decision-capture-service", () => ({
  captureStructuredDecision: jest.fn(),
  createDecisionSchema: { parse: jest.fn() },
}))

jest.mock("@/lib/api/assistant-execution-service", () => ({
  executeAssistantForJobCompletion: jest.fn(),
  validateExecutionInputs: jest.fn(() => null),
}))

jest.mock("@/lib/api/assistant-service", () => ({
  listAccessibleAssistants: jest.fn(),
}))

jest.mock("@/lib/api/route-helpers", () => ({
  isAdminByUserId: jest.fn(),
  checkAssistantResourceGrants: jest.fn(),
}))

jest.mock("@/actions/db/assistant-architect-actions", () => ({
  getAssistantArchitectByIdAction: jest.fn(),
}))

jest.mock("@/lib/agents/agent-tools", () => ({ AGENT_TOOL_HANDLERS: {} }))
jest.mock("@/lib/mcp/content-tool-handlers", () => ({ CONTENT_TOOL_HANDLERS: {} }))
jest.mock("@/lib/capabilities/capability-catalog", () => ({
  buildCapabilityCatalog: jest.fn(),
}))

import { TOOL_HANDLERS } from "@/lib/mcp/tool-handlers"
import {
  executeAssistantForJobCompletion,
  validateExecutionInputs,
} from "@/lib/api/assistant-execution-service"
import { checkAssistantResourceGrants } from "@/lib/api/route-helpers"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"

const mockExecute = executeAssistantForJobCompletion as jest.MockedFunction<
  typeof executeAssistantForJobCompletion
>
const mockCheckGrants = checkAssistantResourceGrants as jest.MockedFunction<
  typeof checkAssistantResourceGrants
>
const mockValidateInputs = validateExecutionInputs as jest.MockedFunction<
  typeof validateExecutionInputs
>
const mockGetArchitect = getAssistantArchitectByIdAction as jest.MockedFunction<
  typeof getAssistantArchitectByIdAction
>

const CONTEXT = {
  userId: 42,
  cognitoSub: "sub-42",
  scopes: ["mcp:execute_assistant"],
  requestId: "req-1",
}

// Minimal architect shape — only the fields the grant gate reads.
const ARCHITECT = {
  id: 7,
  userId: 99, // not the caller — assistant grant check applies
  status: "approved",
  prompts: [
    { id: 1, position: 0, modelId: 11 },
    { id: 2, position: 1, modelId: 12 },
    { id: 3, position: 2, modelId: null }, // must be filtered out, not sent as 0/null
  ],
} as never

function executeHandler(args: Record<string, unknown> = { assistantId: 7 }) {
  return TOOL_HANDLERS.execute_assistant(args, CONTEXT)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockValidateInputs.mockReturnValue(null)
  mockGetArchitect.mockResolvedValue({
    isSuccess: true,
    message: "ok",
    data: ARCHITECT,
  } as never)
  mockCheckGrants.mockResolvedValue({ granted: true })
  mockExecute.mockResolvedValue({
    executionId: 123,
    text: "done",
    usage: null,
  } as never)
})

describe("MCP execute_assistant — per-resource grant gate (#1206/#1223)", () => {
  it("denies execution when the caller lacks the assistant grant (no service call)", async () => {
    mockCheckGrants.mockResolvedValue({ granted: false, reason: "assistant" })

    const result = await executeHandler()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("You do not have access to this assistant")
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("denies execution when the caller lacks a model grant (no service call)", async () => {
    mockCheckGrants.mockResolvedValue({
      granted: false,
      reason: "model",
      deniedModelIds: [12],
    })

    const result = await executeHandler()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(
      "You do not have access to a model this assistant uses"
    )
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("passes the caller id, architect owner/id, and the prompt-chain model ids to the check", async () => {
    await executeHandler()

    expect(mockCheckGrants).toHaveBeenCalledWith({
      userId: 42,
      architectUserId: 99,
      architectId: 7,
      modelDbIds: [11, 12], // null modelId filtered out
    })
  })

  it("executes when the grant check passes", async () => {
    const result = await executeHandler()

    expect(result.isError).toBeUndefined()
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 7, userId: 42 })
    )
    expect(JSON.parse(result.content[0].text as string)).toEqual({
      executionId: 123,
      text: "done",
      usage: null,
    })
  })

  it("rejects inputs that fail the shared REST validation limits (no service call)", async () => {
    // Same validateExecutionInputs REST runs (100 KB / 50 fields / object
    // shape) — the MCP surface must reject what the identical REST call would.
    mockValidateInputs.mockReturnValue([
      { message: "Inputs exceed the 100KB limit" },
    ] as never)

    const result = await executeHandler({ assistantId: 7, inputs: { big: "..." } })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Invalid inputs")
    expect(result.content[0].text).toContain("Inputs exceed the 100KB limit")
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("skips the gate on a failed architect load so the service emits the canonical not-found error", async () => {
    // The psd-aistudio skill maps "Record not found in assistant_architects" to a
    // clean not_executable result — the pre-load must not replace that contract.
    mockGetArchitect.mockResolvedValue({
      isSuccess: false,
      message: "not found",
      data: undefined,
    } as never)
    mockExecute.mockRejectedValue(
      new Error("Record not found in assistant_architects with id: [user input: 7]")
    )

    const result = await executeHandler()

    expect(mockCheckGrants).not.toHaveBeenCalled()
    expect(mockExecute).toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Record not found in assistant_architects")
  })
})
