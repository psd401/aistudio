interface TestInvocationContext {
  actorEmail: string
  mode: "owner" | "scheduled"
  nonce: string
  ownerEmail: string
  sessionId: string
}

let context: TestInvocationContext | null = {
  ownerEmail: "owner@psd401.net",
  actorEmail: "owner@psd401.net",
  mode: "owner",
  nonce: "nonce-test",
  sessionId: "session-test",
}
const getSecretJsonMock = jest.fn()
const executeToolMock = jest.fn()
const listToolsMock = jest.fn()
const acquireAdmissionMock = jest.fn()
const finishAdmissionMock = jest.fn()
const releaseAdmissionMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () => context),
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretJson: (...args: unknown[]) => getSecretJsonMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "request-test",
  sanitizeForLogging: (value: unknown) => value,
}))
jest.mock("@/lib/resource-admission", () => ({
  acquireResourceAdmission: (...args: unknown[]) =>
    acquireAdmissionMock(...args),
  finishResourceAdmission: (...args: unknown[]) =>
    finishAdmissionMock(...args),
  releaseResourceAdmission: (...args: unknown[]) =>
    releaseAdmissionMock(...args),
}))

import type { NextRequest } from "next/server"
import { POST as legacyPOST } from "@/app/api/agent/classified-evaluation/route"
import { POST } from "@/app/api/agent/workflow-gateway/route"
import {
  WorkflowGatewayError,
  workflowGatewayDependencies,
  type WorkflowGatewayTool,
} from "@/lib/agent-services/workflow-gateway"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
    signal: new AbortController().signal,
  } as unknown as NextRequest
}

const originalExecute = workflowGatewayDependencies.execute
const originalListTools = workflowGatewayDependencies.listTools
let executingTool: WorkflowGatewayTool
let preparedArguments: Record<string, unknown> | null

beforeEach(() => {
  context = {
    ownerEmail: "owner@psd401.net",
    actorEmail: "owner@psd401.net",
    mode: "owner",
    nonce: "nonce-test",
    sessionId: "session-test",
  }
  process.env.ENVIRONMENT = "test"
  getSecretJsonMock.mockReset().mockResolvedValue({
    url: "https://gateway.example/sse",
    token: "service-token",
  })
  executingTool = {
    name: "get_example_schema",
    description: "Example schema",
    inputSchema: { type: "object", properties: {} },
  }
  preparedArguments = null
  executeToolMock
    .mockReset()
    .mockImplementation(
      async (
        _config: unknown,
        _toolName: string,
        prepareArguments: (
          tool: WorkflowGatewayTool
        ) => Record<string, unknown>
      ) => {
        preparedArguments = prepareArguments(executingTool)
        return { isError: false, data: { ok: true } }
      }
    )
  listToolsMock.mockReset().mockResolvedValue([
    {
      name: "get_example_schema",
      description: "Example schema",
      inputSchema: { type: "object", properties: {} },
    },
  ])
  acquireAdmissionMock.mockReset().mockResolvedValue({
    allowed: true,
    leaseId: "workflow-lease",
  })
  finishAdmissionMock.mockReset().mockResolvedValue(undefined)
  releaseAdmissionMock.mockReset().mockResolvedValue(undefined)
  workflowGatewayDependencies.execute = executeToolMock
  workflowGatewayDependencies.listTools = listToolsMock
})

afterAll(() => {
  workflowGatewayDependencies.execute = originalExecute
  workflowGatewayDependencies.listTools = originalListTools
})

describe("POST /api/agent/workflow-gateway", () => {
  it("requires signed authority and rejects owner selectors", async () => {
    context = null
    expect((await POST(request({ action: "list-tools" }))).status).toBe(403)
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "owner@psd401.net",
      mode: "owner",
      nonce: "nonce-test",
      sessionId: "session-test",
    }
    expect(
      (
        await POST(
          request({
            toolName: "get_example_schema",
            arguments: {},
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("returns the live tools/list roster", async () => {
    const response = await POST(request({ action: "list-tools" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tools: [
        {
          name: "get_example_schema",
          description: "Example schema",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    })
    expect(listToolsMock).toHaveBeenCalledWith(
      {
        url: "https://gateway.example/sse",
        token: "service-token",
      },
      undefined,
      expect.any(AbortSignal)
    )
  })

  it("flows an unseen roster tool from list to call and binds its caller marker", async () => {
    const dynamicToolName = ["process", "future", "packet"].join("_")
    executingTool = {
      name: dynamicToolName,
      description: "Processes a future workflow packet",
      inputSchema: {
        type: "object",
        properties: {
          requester_email: {
            type: "string",
            description: "Verified requester [caller-bound]",
          },
          approver_email: {
            type: "string",
            description: "[caller-bound] verified approver",
          },
          packet: { type: "string" },
        },
      },
    }
    listToolsMock.mockResolvedValue([executingTool])

    const listed = await POST(request({ action: "list-tools" }))
    expect((await listed.json()).tools[0].name).toBe(dynamicToolName)
    const response = await POST(
      request({
        toolName: dynamicToolName,
        arguments: {
          requester_email: "attacker@psd401.net",
          approver_email: "other-attacker@psd401.net",
          packet: "ready",
        },
      })
    )

    expect(response.status).toBe(200)
    expect(executeToolMock).toHaveBeenCalledWith(
      {
        url: "https://gateway.example/sse",
        token: "service-token",
      },
      dynamicToolName,
      expect.any(Function),
      undefined,
      expect.any(AbortSignal)
    )
    expect(preparedArguments).toEqual({
      requester_email: "owner@psd401.net",
      approver_email: "owner@psd401.net",
      packet: "ready",
    })
  })
})

describe("POST /api/agent/workflow-gateway safety", () => {
  it("rejects an unmarked submit tool with an actionable error", async () => {
    const unsafeSubmitName = ["submit", "future", "packet"].join("_")
    executingTool = {
      name: unsafeSubmitName,
      description: "Submits a workflow packet",
      inputSchema: {
        type: "object",
        properties: {
          employee_email: {
            type: "string",
            description: "The employee who owns the packet",
          },
        },
      },
    }
    const response = await POST(
      request({
        toolName: unsafeSubmitName,
        arguments: { employee_email: "victim@psd401.net" },
      })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: expect.stringContaining("[caller-bound]"),
    })
    expect(executeToolMock).toHaveBeenCalledTimes(1)
  })

  it("rejects tools absent from the live roster", async () => {
    executeToolMock.mockRejectedValueOnce(
      new WorkflowGatewayError(
        "Gateway tool is not available in the live roster",
        "request"
      )
    )
    const response = await POST(
      request({ toolName: "not_in_roster", arguments: {} })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Gateway tool is not available in the live roster",
    })
    expect(executeToolMock).toHaveBeenCalledTimes(1)
  })

  it("binds from the executing schema instead of a stale listed schema", async () => {
    const toolName = "process_rotated_packet"
    listToolsMock.mockResolvedValueOnce([
      {
        name: toolName,
        description: "Cached schema",
        inputSchema: {
          type: "object",
          properties: {
            old_requester: {
              type: "string",
              description: "Old requester [caller-bound]",
            },
          },
        },
      },
    ])
    const listed = await POST(request({ action: "list-tools" }))
    expect(listed.status).toBe(200)

    executingTool = {
      name: toolName,
      description: "Executing schema",
      inputSchema: {
        type: "object",
        properties: {
          current_requester: {
            type: "string",
            description: "Current requester [caller-bound]",
          },
        },
      },
    }
    const response = await POST(
      request({
        toolName,
        arguments: {
          old_requester: "attacker@psd401.net",
          current_requester: "other-attacker@psd401.net",
        },
      })
    )

    expect(response.status).toBe(200)
    expect(preparedArguments).toEqual({
      old_requester: "attacker@psd401.net",
      current_requester: "owner@psd401.net",
    })
    expect(listToolsMock).toHaveBeenCalledTimes(1)
  })

  it("retains the generic argument string-length guard", async () => {
    const response = await POST(
      request({
        toolName: "get_example_schema",
        arguments: { nested: { prose: "x".repeat(20_001) } },
      })
    )
    expect(response.status).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
    expect(listToolsMock).not.toHaveBeenCalled()
  })

  it("keeps consumed capacity charged when settlement fails", async () => {
    finishAdmissionMock.mockRejectedValueOnce(new Error("database unavailable"))
    const response = await POST(request({ action: "list-tools" }))
    expect(response.status).toBe(200)
    expect(releaseAdmissionMock).not.toHaveBeenCalled()
  })
})

describe("legacy classified-evaluation route alias", () => {
  it("exports and runs the exact same handler for one-release compatibility", async () => {
    expect(legacyPOST).toBe(POST)
    const newResponse = await POST(request({ action: "list-tools" }))
    const legacyResponse = await legacyPOST(request({ action: "list-tools" }))
    expect(legacyResponse.status).toBe(newResponse.status)
    expect(await legacyResponse.json()).toEqual(await newResponse.json())
  })
})
