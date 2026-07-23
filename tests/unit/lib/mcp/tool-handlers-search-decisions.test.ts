import { describe, it, expect, beforeEach } from "@jest/globals"

// ============================================
// Mocks — stub the retrieval + graph-service reads; the handler's branch logic
// (semantic vs lexical fallback and its nodeType scoping) is what's under test.
// ============================================

/* eslint-disable no-var */
var mockSemanticSearchNodes = jest.fn()
var mockQueryGraphNodes = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/graph/decision-retrieval", () => ({
  __esModule: true,
  semanticSearchNodes: (...args: unknown[]) => mockSemanticSearchNodes(...args),
  getDecisionPackage: jest.fn(),
}))
jest.mock("@/lib/graph/graph-service", () => ({
  __esModule: true,
  queryGraphNodes: (...args: unknown[]) => mockQueryGraphNodes(...args),
}))

// Heavy sibling modules imported by tool-handlers.ts but unused by search_decisions.
jest.mock("@/lib/graph/decision-capture-service", () => ({
  __esModule: true,
  captureStructuredDecision: jest.fn(),
  createDecisionSchema: { safeParse: jest.fn() },
  describeDecisionError: jest.fn(),
}))
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

const CONTEXT = { userId: 7, cognitoSub: "sub", scopes: ["graph:read"], requestId: "req-1" }

function callSearch(args: Record<string, unknown>) {
  return TOOL_HANDLERS.search_decisions(args, CONTEXT)
}

const EMPTY_PAGE = { items: [], nextCursor: null }

describe("handleSearchDecisions branch scoping", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryGraphNodes.mockResolvedValue(EMPTY_PAGE)
  })

  it("semantic path defaults nodeType to 'decision' when unspecified", async () => {
    mockSemanticSearchNodes.mockResolvedValue([])

    const result = await callSearch({ q: "database choices" })

    expect(mockSemanticSearchNodes).toHaveBeenCalledWith(
      "database choices",
      expect.objectContaining({ nodeType: "decision" })
    )
    expect(mockQueryGraphNodes).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0].text ?? "")).toMatchObject({ method: "semantic" })
  })

  it("lexical FALLBACK keeps the decision default when the semantic path fails", async () => {
    mockSemanticSearchNodes.mockRejectedValue(new Error("Bedrock down"))

    const result = await callSearch({ q: "database choices" })

    expect(mockQueryGraphNodes).toHaveBeenCalledWith(
      expect.objectContaining({ search: "database choices", nodeType: "decision" }),
      expect.anything()
    )
    expect(JSON.parse(result.content[0].text ?? "")).toMatchObject({ method: "lexical-fallback" })
  })

  it("lexical fallback honors an explicit caller nodeType", async () => {
    mockSemanticSearchNodes.mockRejectedValue(new Error("Bedrock down"))

    await callSearch({ q: "committee", nodeType: "person" })

    expect(mockQueryGraphNodes).toHaveBeenCalledWith(
      expect.objectContaining({ nodeType: "person" }),
      expect.anything()
    )
  })

  it("plain lexical `query` (no q) keeps the historical un-scoped default", async () => {
    const result = await callSearch({ query: "anything" })

    expect(mockSemanticSearchNodes).not.toHaveBeenCalled()
    expect(mockQueryGraphNodes).toHaveBeenCalledWith(
      expect.objectContaining({ search: "anything", nodeType: undefined }),
      expect.anything()
    )
    expect(JSON.parse(result.content[0].text ?? "")).toMatchObject({ method: "lexical" })
  })
})
