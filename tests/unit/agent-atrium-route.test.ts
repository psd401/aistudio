let context:
  | { ownerEmail: string; actorEmail: string; mode: "owner" | "scheduled" }
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
import { POST } from "@/app/api/agent/atrium/route"

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
  getSecretStringMock.mockReset().mockResolvedValue("content-key")
  globalThis.fetch = jest.fn(async () =>
    ({
      status: 200,
      text: async () => JSON.stringify({ data: { id: "content-1" } }),
    }) as Response
  ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("POST /api/agent/atrium", () => {
  it("requires signed authority and rejects owner selectors", async () => {
    context = null
    expect((await POST(request({ method: "GET", path: "" }))).status).toBe(403)
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "owner@psd401.net",
      mode: "owner",
    }
    expect(
      (
        await POST(
          request({
            method: "GET",
            path: "",
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(getSecretStringMock).not.toHaveBeenCalled()
  })

  it("uses only the fixed platform content secret and origin", async () => {
    const response = await POST(
      request({
        method: "POST",
        path: "/content-1/versions",
        body: { title: "v2" },
      })
    )
    expect(response.status).toBe(200)
    expect(getSecretStringMock).toHaveBeenCalledWith(
      "psd-agent/test/atrium-content-api-key"
    )
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(String(url)).toBe(
      "https://app.example/api/v1/content/content-1/versions"
    )
    expect(init.headers.Authorization).toBe("Bearer content-key")
    expect(init.redirect).toBe("error")
    expect(JSON.stringify(await response.json())).not.toContain("content-key")
  })

  it.each([
    ["POST", "/content-1/publish/public_web"],
    ["GET", "/content-1/../../admin"],
    ["PUT", "/content-1"],
    ["DELETE", "/content-1/publish/attacker"],
  ])("rejects operation %s %s outside the fixed API surface", async (method, path) => {
    const response = await POST(request({ method, path }))
    expect(response.status).toBe(400)
    expect(getSecretStringMock).not.toHaveBeenCalled()
  })

  it("rejects unexpected query fields", async () => {
    const response = await POST(
      request({
        method: "GET",
        path: "",
        query: { redirect: "https://attacker.example" },
      })
    )
    expect(response.status).toBe(400)
  })
})
