let context:
  | {
      actorEmail: string
      ownerEmail: string
      mode: "owner" | "scheduled"
      sessionId?: string
    }
  | null = {
  actorEmail: "owner@psd401.net",
  ownerEmail: "owner@psd401.net",
  mode: "owner",
  sessionId: "session-1",
}

const getMock = jest.fn()
const listMock = jest.fn()
const putMock = jest.fn()
const requestMock = jest.fn()
const canAccessSkillMock = jest.fn()
const brokerConstructorMock = jest.fn()
const executeRedRoverOperationMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(
    async (
      _request: unknown,
      options?: { allowedModes?: readonly string[] }
    ) =>
      context &&
      (!options?.allowedModes ||
        options.allowedModes.includes(context.mode))
        ? context
        : null
  ),
}))
jest.mock("@/lib/agent-credentials/broker", () => {
  class AgentCredentialInputError extends Error {}
  class AgentCredentialNotConfiguredError extends Error {}
  class AgentCredentialBroker {
    constructor() {
      brokerConstructorMock()
      return {
        get: getMock,
        list: listMock,
        put: putMock,
        request: requestMock,
        canAccessSkill: canAccessSkillMock,
      }
    }
  }
  return {
    AgentCredentialBroker,
    AgentCredentialInputError,
    AgentCredentialNotConfiguredError,
  }
})
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "request-test",
}))
jest.mock("@/lib/agent-credentials/owner-operation-broker", () => ({
  executeOpenAiImageOperation: jest.fn(),
  executePlaudOperation: jest.fn(),
  executePsdDataOperation: jest.fn(),
  executeRedRoverOperation: (...args: unknown[]) =>
    executeRedRoverOperationMock(...args),
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/credentials/route"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  context = {
    actorEmail: "owner@psd401.net",
    ownerEmail: "owner@psd401.net",
    mode: "owner",
    sessionId: "session-1",
  }
  brokerConstructorMock.mockClear()
  getMock.mockReset().mockResolvedValue({
    name: "github",
    value: "secret",
    scope: "user",
  })
  listMock.mockReset().mockResolvedValue([])
  putMock.mockReset().mockResolvedValue({
    name: "github",
    action: "created",
  })
  requestMock.mockReset().mockResolvedValue(42)
  canAccessSkillMock.mockReset().mockResolvedValue(true)
  executeRedRoverOperationMock.mockReset().mockResolvedValue({
    data: [],
    total: 0,
  })
})

describe("POST /api/agent/credentials", () => {
  it("requires a signed owner or scheduled context", async () => {
    context = null
    const response = await POST(request({ operation: "list" }))
    expect(response.status).toBe(403)
    expect(brokerConstructorMock).not.toHaveBeenCalled()
  })

  it.each(["ownerEmail", "userEmail", "userId"])(
    "rejects model-supplied authority field %s",
    async (field) => {
      const response = await POST(
        request({ operation: "get", name: "github", [field]: "victim" })
      )
      expect(response.status).toBe(400)
      expect(brokerConstructorMock).not.toHaveBeenCalled()
    }
  )

  it.each(["get", "list"])(
    "denies the generic plaintext credential %s oracle",
    async (operation) => {
      const response = await POST(request({ operation, name: "github" }))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: "Plaintext credential access is not supported",
      })
      expect(getMock).not.toHaveBeenCalled()
      expect(listMock).not.toHaveBeenCalled()
    }
  )

  it("never returns a reusable credential in a denial", async () => {
    const response = await POST(request({ operation: "get", name: "github" }))
    expect(JSON.stringify(await response.json())).not.toContain("secret")
  })

  it("allows scheduled access checks but forbids scheduled writes and requests", async () => {
    context = {
      actorEmail: "cron@internal",
      ownerEmail: "owner@psd401.net",
      mode: "scheduled",
      sessionId: "schedule-1",
    }
    expect(
      (
        await POST(
          request({
            operation: "check-skill-access",
            capability: "restricted.research",
          })
        )
      ).status
    ).toBe(200)
    expect(
      (
        await POST(
          request({ operation: "put", name: "github", value: "new-secret" })
        )
      ).status
    ).toBe(403)
    expect(
      (
        await POST(
          request({
            operation: "request",
            name: "github",
            reason: "needed",
          })
        )
      ).status
    ).toBe(403)
    expect(putMock).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it("checks skill access only for the signed owner", async () => {
    const response = await POST(
      request({
        operation: "check-skill-access",
        capability: "restricted.research",
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ granted: true })
    expect(canAccessSkillMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      "restricted.research",
      undefined
    )
  })

  it("denies Red Rover before the shared credential operation", async () => {
    canAccessSkillMock.mockResolvedValueOnce(false)
    const response = await POST(
      request({
        operation: "redrover",
        action: "vacancies",
        startDate: "2026-07-01",
        endDate: "2026-07-02",
      })
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Forbidden" })
    expect(canAccessSkillMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      "skill.redrover",
      undefined
    )
    expect(executeRedRoverOperationMock).not.toHaveBeenCalled()
    expect(getMock).not.toHaveBeenCalled()
  })

  it("allows a granted signed owner to run Red Rover", async () => {
    const response = await POST(
      request({
        operation: "redrover",
        action: "vacancies",
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        filledFilter: "unfilled",
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [], total: 0 })
    expect(canAccessSkillMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      "skill.redrover",
      undefined
    )
    expect(executeRedRoverOperationMock).toHaveBeenCalledWith({
      ownerEmail: "owner@psd401.net",
      sessionId: "session-1",
      operation: "vacancies",
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      filledFilter: "unfilled",
    })
  })
})
