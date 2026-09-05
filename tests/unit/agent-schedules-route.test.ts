let context:
  | {
      actorEmail: string
      ownerEmail: string
      mode: "owner" | "scheduled" | "consultation" | "email-task"
    }
  | null = {
  actorEmail: "owner@psd401.net",
  ownerEmail: "owner@psd401.net",
  mode: "owner",
}

const listMock = jest.fn()
const createMock = jest.fn()
const updateMock = jest.fn()
const deleteMock = jest.fn()
const runsMock = jest.fn()
const serviceFactoryMock = jest.fn(() => ({
  list: listMock,
  create: createMock,
  update: updateMock,
  delete: deleteMock,
  runs: runsMock,
}))

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(
    async (
      _request: unknown,
      options?: {
        allowedModes?: readonly string[]
        reportModeMismatch?: boolean
      }
    ) => {
      if (!context) return null
      if (
        !options?.allowedModes ||
        options.allowedModes.includes(context.mode)
      ) {
        return context
      }
      return options.reportModeMismatch
        ? { reason: "mode_not_allowed", context }
        : null
    }
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
  runsMock.mockReset().mockResolvedValue([])
})

describe("POST /api/agent/schedules", () => {
  it("keeps failed invocation verification opaque", async () => {
    context = null
    const response = await POST(request({ operation: "create" }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" })
    expect(serviceFactoryMock).not.toHaveBeenCalled()
  })

  it.each(["create", "update", "delete"])(
    "refuses %s from a scheduled run without weakening the crypto ordering",
    async (operation) => {
      context = {
        actorEmail: "owner@psd401.net",
        ownerEmail: "owner@psd401.net",
        mode: "scheduled",
      }
      const response = await POST(request({ operation }))

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error:
          "Creating, updating, or deleting a schedule requires a live " +
          "owner-mode turn. A scheduled run may only list schedules and read " +
          "their runs.",
        mode: "scheduled",
      })
      expect(serviceFactoryMock).not.toHaveBeenCalled()
    }
  )

  it.each(["list", "runs"])(
    "lets a scheduled run audit its own schedules via %s",
    async (operation) => {
      context = {
        actorEmail: "owner@psd401.net",
        ownerEmail: "owner@psd401.net",
        mode: "scheduled",
      }
      const response = await POST(request({ operation }))

      expect(response.status).toBe(200)
      expect(serviceFactoryMock).toHaveBeenCalled()
    }
  )

  it.each(["consultation", "email-task"])(
    "still reports a plain mode mismatch for %s",
    async (mode) => {
      context = {
        actorEmail: "owner@psd401.net",
        ownerEmail: "owner@psd401.net",
        mode: mode as "consultation" | "email-task",
      }
      const response = await POST(request({ operation: "list" }))

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: "Schedule management requires a live owner-mode turn",
        reason: "mode_not_allowed",
        mode,
      })
      expect(serviceFactoryMock).not.toHaveBeenCalled()
    }
  )

  it("rejects a scheduled mutation before any authority selector is read", async () => {
    context = {
      actorEmail: "owner@psd401.net",
      ownerEmail: "owner@psd401.net",
      mode: "scheduled",
    }
    // The authority-selector guard runs first and is unchanged: a scheduled
    // turn cannot use a rejected mutation to probe for it either way.
    const response = await POST(
      request({ operation: "delete", ownerEmail: "victim@psd401.net" })
    )

    expect(response.status).toBe(400)
    expect(deleteMock).not.toHaveBeenCalled()
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
