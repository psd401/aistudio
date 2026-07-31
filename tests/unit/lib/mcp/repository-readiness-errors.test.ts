import { beforeEach, describe, expect, it } from "@jest/globals"

/* eslint-disable no-var */
var mockSearchRepositoryCatalog = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/repositories/repository-catalog-service", () => ({
  __esModule: true,
  describeRepository: jest.fn(),
  getRepositorySource: jest.fn(),
  listRepositoryCatalog: jest.fn(),
  listRepositoryChanges: jest.fn(),
  searchRepositoryCatalog: (...args: unknown[]) =>
    mockSearchRepositoryCatalog(...args),
}))
jest.mock("@/lib/graph/decision-retrieval", () => ({
  __esModule: true,
  getDecisionPackage: jest.fn(),
  semanticSearchNodes: jest.fn(),
}))
jest.mock("@/lib/graph/graph-service", () => ({
  __esModule: true,
  queryGraphNodes: jest.fn(),
}))
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
  checkAssistantResourceGrants: jest.fn(),
  isAdminByUserId: jest.fn(),
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
import { RepositoryReadinessError } from "@/lib/repositories/readiness-service"

const CONTEXT = {
  userId: 7,
  cognitoSub: "user-sub",
  scopes: ["repositories:read"],
  requestId: "request-1",
}

describe("MCP repository readiness errors", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns an actionable tool error instead of hiding readiness as an internal failure", async () => {
    mockSearchRepositoryCatalog.mockRejectedValue(
      new RepositoryReadinessError(
        "REPOSITORY_NOT_READY",
        "Repository 39 is still processing.",
        [
          {
            repositoryId: 39,
            readiness: "processing",
            activeGenerationId: null,
            indexedItemCount: 0,
            segmentCount: 0,
            lastIndexError: null,
          },
        ]
      )
    )

    const result = await TOOL_HANDLERS.repositories_search(
      { query: "unique canary fact", repositoryIds: [39] },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text ?? "")).toEqual({
      error: "REPOSITORY_NOT_READY",
      message: "Repository 39 is still processing.",
      repositories: [
        expect.objectContaining({
          repositoryId: 39,
          readiness: "processing",
        }),
      ],
    })
  })

  it("does not mask unexpected implementation failures as readiness errors", async () => {
    mockSearchRepositoryCatalog.mockRejectedValue(new Error("database offline"))

    await expect(
      TOOL_HANDLERS.repositories_search({ query: "fact" }, CONTEXT)
    ).rejects.toThrow("database offline")
  })
})
