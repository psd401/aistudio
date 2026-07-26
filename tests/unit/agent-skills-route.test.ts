let context:
  | { actorEmail: string; ownerEmail: string; mode: "owner" | "scheduled" }
  | null = {
  actorEmail: "owner@psd401.net",
  ownerEmail: "owner@psd401.net",
  mode: "owner",
}

const searchMock = jest.fn()
const loadMock = jest.fn()
const authorMock = jest.fn()
const serviceConstructorMock = jest.fn()

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
jest.mock("@/lib/agent-skills/service", () => {
  class AgentSkillInputError extends Error {}
  class AgentSkillOwnerNotFoundError extends Error {}
  class AgentSkillsService {
    constructor() {
      serviceConstructorMock()
      return {
        search: searchMock,
        load: loadMock,
        author: authorMock,
      }
    }
  }
  return {
    AgentSkillInputError,
    AgentSkillOwnerNotFoundError,
    AgentSkillsService,
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

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/skills/route"

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
  serviceConstructorMock.mockClear()
  searchMock.mockReset().mockResolvedValue([])
  loadMock.mockReset().mockResolvedValue({
    name: "safe-skill",
    skillMd: "---\nname: safe-skill\n---",
  })
  authorMock.mockReset().mockResolvedValue({
    skillId: "skill-1",
    name: "owner-skill",
    scanQueued: true,
  })
})

describe("POST /api/agent/skills", () => {
  it("requires an owner-mode signed context", async () => {
    context = {
      actorEmail: "cron@internal",
      ownerEmail: "owner@psd401.net",
      mode: "scheduled",
    }
    expect((await POST(request({ operation: "search", query: "x" }))).status)
      .toBe(403)
    expect(serviceConstructorMock).not.toHaveBeenCalled()
  })

  it.each(["ownerEmail", "userEmail", "userId"])(
    "rejects model-supplied authority field %s",
    async (field) => {
      const response = await POST(
        request({ operation: "search", query: "x", [field]: "victim" })
      )
      expect(response.status).toBe(400)
      expect(serviceConstructorMock).not.toHaveBeenCalled()
    }
  )

  it("passes only the signed owner to catalog search", async () => {
    const response = await POST(
      request({ operation: "search", query: "report" })
    )
    expect(response.status).toBe(200)
    expect(searchMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      "report"
    )
  })

  it("passes only the signed owner to authoring", async () => {
    const response = await POST(
      request({
        operation: "author",
        name: "owner-skill",
        summary: "Summary",
        skillMdBase64: "LS0tCg==",
        files: [],
      })
    )
    expect(response.status).toBe(201)
    expect(authorMock).toHaveBeenCalledWith("owner@psd401.net", {
      name: "owner-skill",
      summary: "Summary",
      skillMdBase64: "LS0tCg==",
      files: [],
    })
  })
})
