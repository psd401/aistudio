let context:
  | { ownerEmail: string; actorEmail: string; mode: "owner" | "scheduled" }
  | null = {
  ownerEmail: "owner@psd401.net",
  actorEmail: "owner@psd401.net",
  mode: "owner",
}
const getSecretJsonMock = jest.fn()
const storeCanvaRefreshTokenMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () => context),
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  canvaSecretId: (ownerEmail: string) =>
    `psd-agent-creds/test/user/${ownerEmail}/canva`,
  getSecretJson: (...args: unknown[]) => getSecretJsonMock(...args),
  storeCanvaRefreshToken: (...args: unknown[]) =>
    storeCanvaRefreshTokenMock(...args),
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
import { POST } from "@/app/api/agent/canva/route"

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
  process.env.ENVIRONMENT = "test"
  getSecretJsonMock.mockReset()
  storeCanvaRefreshTokenMock.mockReset().mockResolvedValue("arn:test")
  globalThis.fetch = jest
    .fn()
    .mockResolvedValueOnce(
      {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "rotated-token",
          scope: "design:meta:read",
        }),
      } as Response
    )
    .mockResolvedValueOnce(
      {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [] }),
        headers: { get: () => null },
      } as unknown as Response
    ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("POST /api/agent/canva", () => {
  it("requires a signed context and rejects owner selectors", async () => {
    context = null
    expect((await POST(request({ operation: "status" }))).status).toBe(403)
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "owner@psd401.net",
      mode: "owner",
    }
    expect(
      (
        await POST(
          request({
            operation: "status",
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("checks connection state only for the signed owner", async () => {
    getSecretJsonMock.mockResolvedValue({
      refresh_token: "stored",
      obtained_at: "2026-01-01T00:00:00Z",
    })
    const response = await POST(request({ operation: "status" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connected: true })
    expect(getSecretJsonMock).toHaveBeenCalledWith(
      "psd-agent-creds/test/user/owner@psd401.net/canva"
    )
  })

  it("refreshes and rotates the signed owner's token without exposing it", async () => {
    getSecretJsonMock
      .mockResolvedValueOnce({
        refresh_token: "stored-token",
        obtained_at: "2026-01-01T00:00:00Z",
      })
      .mockResolvedValueOnce({
        client_id: "client-id",
        client_secret: "client-secret",
      })
    const response = await POST(
      request({
        operation: "request",
        method: "GET",
        path: "/v1/designs",
        query: { query: "poster" },
      })
    )
    expect(response.status).toBe(200)
    expect(storeCanvaRefreshTokenMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      expect.objectContaining({ refresh_token: "rotated-token" })
    )
    const tokenFetch = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(String(tokenFetch[0])).toBe(
      "https://api.canva.com/rest/v1/oauth/token"
    )
    expect(tokenFetch[1].redirect).toBe("error")
    const apiFetch = (globalThis.fetch as jest.Mock).mock.calls[1]
    expect(String(apiFetch[0])).toBe(
      "https://api.canva.com/rest/v1/designs?query=poster"
    )
    expect(apiFetch[1].headers.Authorization).toBe("Bearer access-token")
    expect(apiFetch[1].redirect).toBe("error")
    const serializedResponse = JSON.stringify(await response.json())
    expect(serializedResponse).not.toContain("access-token")
    expect(serializedResponse).not.toContain("rotated-token")
  })

  it.each([
    ["GET", "https://attacker.example/v1/designs"],
    ["POST", "/v1/users/me"],
    ["DELETE", "/v1/designs"],
    ["GET", "/v1/exports/../../admin"],
  ])("rejects method/path %s %s outside the named surface", async (method, path) => {
    const response = await POST(
      request({ operation: "request", method, path })
    )
    expect(response.status).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("rejects malformed upload metadata before reading credentials", async () => {
    const response = await POST(
      request({
        operation: "request",
        method: "POST",
        path: "/v1/asset-uploads",
        rawBodyBase64: Buffer.from("asset").toString("base64"),
        uploadMetadata: '{"name_base64":"../../etc/passwd"}',
      })
    )
    expect(response.status).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })
})
