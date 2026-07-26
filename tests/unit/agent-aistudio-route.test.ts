let context:
  | {
      ownerEmail: string
      actorEmail: string
      mode: "owner" | "scheduled"
    }
  | null = {
  ownerEmail: "owner@psd401.net",
  actorEmail: "owner@psd401.net",
  mode: "owner",
}

const getSecretStringMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () => context),
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretString: (...args: unknown[]) => getSecretStringMock(...args),
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
import { POST } from "@/app/api/agent/aistudio/route"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  context = {
    ownerEmail: "owner@psd401.net",
    actorEmail: "owner@psd401.net",
    mode: "owner",
  }
  process.env.APP_BASE_URL = "https://app.example"
  process.env.ENVIRONMENT = "test"
  getSecretStringMock.mockReset().mockResolvedValue("personal-key")
  globalThis.fetch = jest.fn(async () =>
    ({
      status: 200,
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: "upstream",
          result: { ok: true },
        }),
    }) as Response
  ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("POST /api/agent/aistudio", () => {
  it("rejects missing context and model-supplied owner selectors", async () => {
    context = null
    expect(
      (await POST(request({ method: "tools/list", params: {} }))).status
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
            method: "tools/list",
            params: {},
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(getSecretStringMock).not.toHaveBeenCalled()
  })

  it("derives the personal credential path from the signed owner", async () => {
    const response = await POST(
      request({
        method: "tools/call",
        params: { name: "describe_capabilities", arguments: {} },
      })
    )
    expect(response.status).toBe(200)
    expect(getSecretStringMock).toHaveBeenCalledWith(
      "psd-agent-creds/test/user/owner@psd401.net/aistudio_personal_key"
    )
    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(String(fetchCall[0])).toBe("https://app.example/api/mcp")
    expect(fetchCall[1].headers.Authorization).toBe("Bearer personal-key")
    expect(fetchCall[1].redirect).toBe("error")
    expect(JSON.stringify(await response.json())).not.toContain("personal-key")
  })

  it("falls back only to the fixed platform secret", async () => {
    getSecretStringMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("shared-key")
    const response = await POST(
      request({ method: "tools/list", params: {} })
    )
    expect(response.status).toBe(200)
    expect(getSecretStringMock).toHaveBeenNthCalledWith(
      2,
      "psd-agent/test/aistudio-mcp-api-key"
    )
    expect(await response.json()).toEqual(
      expect.objectContaining({ keySource: "shared", httpStatus: 200 })
    )
  })

  it("rejects malformed tool calls before reading credentials", async () => {
    const response = await POST(
      request({
        method: "tools/call",
        params: {
          name: "../../admin",
          arguments: {},
        },
      })
    )
    expect(response.status).toBe(400)
    expect(getSecretStringMock).not.toHaveBeenCalled()
  })
})
