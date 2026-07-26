let context:
  | { ownerEmail: string; actorEmail: string; mode: "owner" | "scheduled" }
  | null = {
  ownerEmail: "owner@psd401.net",
  actorEmail: "owner@psd401.net",
  mode: "owner",
}
const getSecretJsonMock = jest.fn()
const executeToolMock = jest.fn()

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

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/classified-evaluation/route"
import { classifiedGatewayDependencies } from "@/lib/agent-services/classified-gateway"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  context = {
    ownerEmail: "owner@psd401.net",
    actorEmail: "owner@psd401.net",
    mode: "owner",
  }
  process.env.ENVIRONMENT = "test"
  getSecretJsonMock.mockReset().mockResolvedValue({
    url: "https://gateway.example/sse",
    token: "service-token",
  })
  executeToolMock.mockReset().mockResolvedValue({
    isError: false,
    data: { ok: true },
  })
  classifiedGatewayDependencies.execute = executeToolMock
})

describe("POST /api/agent/classified-evaluation", () => {
  it("requires signed authority and rejects owner selectors", async () => {
    context = null
    expect(
      (
        await POST(
          request({
            toolName: "get_classified_evaluation_schema",
            arguments: {},
          })
        )
      ).status
    ).toBe(403)
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "owner@psd401.net",
      mode: "owner",
    }
    expect(
      (
        await POST(
          request({
            toolName: "get_classified_evaluation_schema",
            arguments: {},
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("overrides the model-selected evaluator with the signed owner", async () => {
    const response = await POST(
      request({
        toolName: "list_supervised_employees",
        arguments: { evaluator_email: "victim@psd401.net" },
      })
    )
    expect(response.status).toBe(200)
    expect(getSecretJsonMock).toHaveBeenCalledWith(
      "psd-agent/test/agent-gateway"
    )
    expect(executeToolMock).toHaveBeenCalledWith(
      {
        url: "https://gateway.example/sse",
        token: "service-token",
      },
      "list_supervised_employees",
      { evaluator_email: "owner@psd401.net" }
    )
    expect(JSON.stringify(await response.json())).not.toContain("service-token")
  })

  it("binds submit evaluator identity and validates rating values", async () => {
    const response = await POST(
      request({
        toolName: "submit_classified_evaluation",
        arguments: {
          evaluator_email: "victim@psd401.net",
          employee_email: "Employee@psd401.net",
          rating_quality: "Good",
          supervisor_comments: "Well done",
        },
      })
    )
    expect(response.status).toBe(200)
    expect(executeToolMock).toHaveBeenCalledWith(
      expect.any(Object),
      "submit_classified_evaluation",
      expect.objectContaining({
        evaluator_email: "owner@psd401.net",
        employee_email: "employee@psd401.net",
      })
    )
    expect(
      (
        await POST(
          request({
            toolName: "submit_classified_evaluation",
            arguments: {
              employee_email: "employee@psd401.net",
              rating_quality: "Perfect",
            },
          })
        )
      ).status
    ).toBe(400)
  })

  it("rejects arbitrary gateway tools before reading the secret", async () => {
    const response = await POST(
      request({ toolName: "raw_http_request", arguments: {} })
    )
    expect(response.status).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })
})
