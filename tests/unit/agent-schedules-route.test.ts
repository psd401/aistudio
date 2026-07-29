let context:
  | { actorEmail: string; ownerEmail: string; mode: "owner" | "scheduled" }
  | null = {
  actorEmail: "owner@psd401.net",
  ownerEmail: "owner@psd401.net",
  mode: "owner",
}

const listMock = jest.fn()
const createMock = jest.fn()
const updateMock = jest.fn()
const deleteMock = jest.fn()
const serviceFactoryMock = jest.fn(() => ({
  list: listMock,
  create: createMock,
  update: updateMock,
  delete: deleteMock,
}))

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
jest.mock("@/lib/agent-schedules/service", () => {
  class AgentScheduleConflictError extends Error {}
  class AgentScheduleNotConfiguredError extends Error {}
  class AgentScheduleNotFoundError extends Error {}
  class AgentScheduleQuotaError extends Error {}
  class AgentScheduleSyncError extends Error {}
  class AgentScheduleUserNotReadyError extends Error {}
  return {
    AgentScheduleConflictError,
    AgentScheduleNotConfiguredError,
    AgentScheduleNotFoundError,
    AgentScheduleQuotaError,
    AgentScheduleSyncError,
    AgentScheduleUserNotReadyError,
    createAgentScheduleService: () => serviceFactoryMock(),
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
  sanitizeForLogging: (value: unknown) => value,
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/schedules/route"

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
  }
  serviceFactoryMock.mockClear()
  listMock.mockReset().mockResolvedValue([])
  createMock.mockReset().mockResolvedValue({ scheduleId: "schedule-1" })
  updateMock.mockReset().mockResolvedValue({ scheduleId: "schedule-1" })
  deleteMock.mockReset().mockResolvedValue("schedule-1")
})

describe("POST /api/agent/schedules", () => {
  it("rejects absent or non-owner signed contexts", async () => {
    context = null
    expect((await POST(request({ operation: "list" }))).status).toBe(403)
    context = {
      actorEmail: "owner@psd401.net",
      ownerEmail: "owner@psd401.net",
      mode: "scheduled",
    }
    expect((await POST(request({ operation: "list" }))).status).toBe(403)
    expect(serviceFactoryMock).not.toHaveBeenCalled()
  })

  it.each([
    "ownerEmail",
    "userEmail",
    "userId",
    "googleIdentity",
    "dmSpaceName",
    "workspacePrefix",
  ])("rejects model-supplied authority field %s", async (field) => {
    const response = await POST(
      request({ operation: "create", [field]: "attacker-selected" })
    )
    expect(response.status).toBe(400)
    expect(serviceFactoryMock).not.toHaveBeenCalled()
  })

  it("passes only the signed owner to list", async () => {
    const response = await POST(request({ operation: "list" }))
    expect(response.status).toBe(200)
    expect(listMock).toHaveBeenCalledWith("owner@psd401.net")
  })

  it("passes schedule spec with the signed owner to create", async () => {
    const spec = {
      operation: "create",
      name: "Morning brief",
      prompt: "Summarize my day",
      cron: "0 8 * * *",
      timezone: "America/Los_Angeles",
      disabled: false,
    }
    const response = await POST(request(spec))
    expect(response.status).toBe(201)
    expect(createMock).toHaveBeenCalledWith("owner@psd401.net", {
      name: spec.name,
      prompt: spec.prompt,
      cron: spec.cron,
      timezone: spec.timezone,
      disabled: false,
    })
  })
})
