let contextOwner: string | null = "owner@psd401.net"

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () =>
    contextOwner
      ? {
          actorEmail: contextOwner,
          ownerEmail: contextOwner,
          mode: "owner",
        }
      : null
  ),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
  generateRequestId: () => "rid-test",
}))

const executeQueryMock = jest.fn(
  async (_query: unknown, operation: string): Promise<unknown[]> =>
    operation === "checkConsentLinkRateLimit" ? [{ count: 0 }] : []
)
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (query: unknown, operation: string) =>
    executeQueryMock(query, operation),
}))

const signConsentTokenMock = jest.fn(
  async (_claims: unknown) => "signed-consent-token"
)
jest.mock("@/lib/agent-workspace/consent-token", () => ({
  signConsentToken: (claims: unknown) => signConsentTokenMock(claims),
}))
jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://app.test",
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/consent-link/route"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  contextOwner = "owner@psd401.net"
  executeQueryMock.mockClear()
  signConsentTokenMock.mockClear()
})

describe("POST /api/agent/consent-link", () => {
  it("requires a signed owner context", async () => {
    contextOwner = null
    expect(
      (await POST(request({ kind: "canva" }))).status
    ).toBe(403)
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("rejects a body-selected victim before nonce persistence", async () => {
    const response = await POST(
      request({ ownerEmail: "victim@psd401.net", kind: "canva" })
    )
    expect(response.status).toBe(400)
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(signConsentTokenMock).not.toHaveBeenCalled()
  })

  it("mints consent only for the owner bound by the signed invocation", async () => {
    const response = await POST(
      request({ kind: "canva" })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      url: "https://app.test/agent-connect-canva?token=signed-consent-token",
    })
    expect(signConsentTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: "owner@psd401.net",
        agent: "agnt_owner@psd401.net",
        kind: "canva",
      })
    )
    expect(executeQueryMock).toHaveBeenCalledTimes(2)
  })
})
