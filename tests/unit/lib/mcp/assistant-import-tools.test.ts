import {
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals"

/* eslint-disable no-var */
var mockCreateAssistantsFromImport: jest.Mock
var mockUpdateAssistantFromImport: jest.Mock
var mockForkAssistant: jest.Mock
/* eslint-enable no-var */

mockCreateAssistantsFromImport = jest.fn()
mockUpdateAssistantFromImport = jest.fn()
mockForkAssistant = jest.fn()

jest.mock("@/lib/assistant-architect/import-service", () => {
  class TestAssistantImportServiceError extends Error {
    constructor(
      public readonly code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT",
      message: string,
    ) {
      super(message)
    }
  }
  return {
    AssistantImportServiceError: TestAssistantImportServiceError,
    createAssistantsFromImport: (...args: unknown[]) =>
      mockCreateAssistantsFromImport(...args),
    updateAssistantFromImport: (...args: unknown[]) =>
      mockUpdateAssistantFromImport(...args),
    forkAssistant: (...args: unknown[]) => mockForkAssistant(...args),
  }
})

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("@/lib/mcp/content-tool-handlers", () => ({
  CONTENT_TOOL_HANDLERS: {},
}))

jest.mock("@/lib/agents/agent-tools", () => ({
  AGENT_TOOL_HANDLERS: {},
}))

import { TOOL_HANDLERS } from "@/lib/mcp/tool-handlers"
import { handleJsonRpcRequest } from "@/lib/mcp/jsonrpc-handler"
import type { McpToolContext } from "@/lib/mcp/types"
import { buildCapabilityCatalog } from "@/lib/capabilities/capability-catalog"
import { ROLE_SCOPES } from "@/lib/api-keys/scopes"
import { AssistantImportServiceError } from "@/lib/assistant-architect/import-service"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"

const context: McpToolContext = {
  userId: 7,
  cognitoSub: "staff-sub",
  scopes: ["*"],
  requestId: "req-assistant-import",
}

const importEnvelope = {
  version: "1.0",
  exported_at: "2026-07-28T00:00:00.000Z",
  assistants: [
    {
      name: "MCP assistant",
      description: "Created through MCP",
      status: "approved",
      prompts: [
        {
          name: "Prompt",
          content: "Hello",
          model_name: "gpt-source",
          position: 0,
        },
      ],
      input_fields: [],
    },
  ],
}

describe("MCP assistant import tools", () => {
  beforeEach(() => {
    mockCreateAssistantsFromImport.mockReset()
    mockUpdateAssistantFromImport.mockReset()
    mockForkAssistant.mockReset()
    toolCatalogInstance.invalidate()

    mockCreateAssistantsFromImport.mockResolvedValue({
      total: 1,
      successful: 1,
      failed: 0,
      results: [
        {
          name: "MCP assistant",
          id: 31,
          status: "pending_approval",
        },
      ],
      modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
    })
    mockUpdateAssistantFromImport.mockResolvedValue({
      result: {
        name: "MCP assistant",
        id: 31,
        status: "pending_approval",
      },
      modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
    })
    mockForkAssistant.mockResolvedValue({
      result: {
        name: "MCP assistant copy",
        id: 32,
        status: "pending_approval",
      },
      modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
    })
  })

  it("registers concrete handlers for create, update, and fork", () => {
    expect(typeof TOOL_HANDLERS.create_assistant).toBe("function")
    expect(typeof TOOL_HANDLERS.update_assistant).toBe("function")
    expect(typeof TOOL_HANDLERS.fork_assistant).toBe("function")
  })

  it("delegates create to the shared import service as the caller", async () => {
    const result = await TOOL_HANDLERS.create_assistant(
      importEnvelope,
      context,
    )

    expect(mockCreateAssistantsFromImport).toHaveBeenCalledWith(
      importEnvelope,
      7,
    )
    expect(JSON.parse(result.content[0].text ?? "{}")).toMatchObject({
      data: {
        results: [{ id: 31, status: "pending_approval" }],
      },
    })
  })

  it("delegates update and fork with validated numeric ids", async () => {
    await TOOL_HANDLERS.update_assistant(
      { assistantId: 31, ...importEnvelope },
      context,
    )
    await TOOL_HANDLERS.fork_assistant(
      { assistantId: 31, name: "MCP assistant copy" },
      context,
    )

    expect(mockUpdateAssistantFromImport).toHaveBeenCalledWith(
      31,
      importEnvelope,
      7,
    )
    expect(mockForkAssistant).toHaveBeenCalledWith(
      31,
      7,
      "MCP assistant copy",
    )
  })

  it("scope-denies create and update before dispatch", async () => {
    const createResponse = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 1,
        params: {
          name: "create_assistant",
          arguments: importEnvelope,
        },
      },
      { ...context, scopes: [] },
    )
    const updateResponse = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 2,
        params: {
          name: "update_assistant",
          arguments: { assistantId: 31, ...importEnvelope },
        },
      },
      { ...context, scopes: [] },
    )

    expect(createResponse.error?.code).toBe(-32602)
    expect(createResponse.error?.message).toMatch(/Insufficient scope/)
    expect(updateResponse.error?.code).toBe(-32602)
    expect(updateResponse.error?.message).toMatch(/Insufficient scope/)
    expect(mockCreateAssistantsFromImport).not.toHaveBeenCalled()
    expect(mockUpdateAssistantFromImport).not.toHaveBeenCalled()
  })

  it("describe_capabilities includes all three assistant mutations", () => {
    const identifiers = buildCapabilityCatalog({
      section: "actions",
      surface: "mcp",
    }).actions?.map((action) => action.identifier)

    expect(identifiers).toEqual(
      expect.arrayContaining([
        "assistants.create",
        "assistants.update",
        "assistants.fork",
      ]),
    )
  })

  it("grants REST and MCP write scopes to staff and administrators", () => {
    const expected = [
      "assistants:write",
      "mcp:create_assistant",
      "mcp:update_assistant",
      "mcp:fork_assistant",
    ]
    expect(ROLE_SCOPES.staff).toEqual(expect.arrayContaining(expected))
    expect(ROLE_SCOPES.administrator).toEqual(
      expect.arrayContaining(expected),
    )
  })
})

describe("MCP assistant import service authorization errors", () => {
  beforeEach(() => {
    mockUpdateAssistantFromImport.mockReset()
    mockForkAssistant.mockReset()
  })

  it("returns a masked not-found error for another owner's assistant", async () => {
    mockUpdateAssistantFromImport.mockRejectedValue(
      new AssistantImportServiceError(
        "NOT_FOUND",
        "Assistant not found: 31",
      ),
    )

    const result = await TOOL_HANDLERS.update_assistant(
      { assistantId: 31, ...importEnvelope },
      context,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("Assistant not found: 31")
  })

  it("returns a masked not-found error for an invisible fork source", async () => {
    mockForkAssistant.mockRejectedValue(
      new AssistantImportServiceError("NOT_FOUND", "Assistant not found: 31"),
    )

    const result = await TOOL_HANDLERS.fork_assistant(
      { assistantId: 31 },
      context,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("Assistant not found: 31")
  })
})
