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
// NOTE: @/lib/agent-credentials/name-grammar is deliberately NOT mocked. The
// route validates credential_entry slot names with the broker's real grammar
// (#1887), and a mocked copy here would let that rule drift unnoticed.
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

/**
 * Credential-entry links (#1887). The slot name is the one piece of extra
 * state this kind carries, and it must reach the signed token — the page has
 * nowhere to put the secret without it.
 */
describe("POST /api/agent/consent-link — credential_entry", () => {
  it("mints a link to the entry page with the slot name in the token", async () => {
    const response = await POST(
      request({ kind: "credential_entry", name: "freshservice_api_key" })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      url: "https://app.test/agent-connect-credential?token=signed-consent-token",
    })
    expect(signConsentTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: "owner@psd401.net",
        kind: "credential_entry",
        cred: "freshservice_api_key",
      })
    )
  })

  it("requires a slot name, and persists no nonce without one", async () => {
    const response = await POST(request({ kind: "credential_entry" }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/name is required/)
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(signConsentTokenMock).not.toHaveBeenCalled()
  })

  it.each([
    ["path traversal", "../../shared/openai"],
    ["a slash", "user/freshservice"],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("rejects %s as a slot name", async (_label, name) => {
    const response = await POST(request({ kind: "credential_entry", name }))
    expect(response.status).toBe(400)
    expect(signConsentTokenMock).not.toHaveBeenCalled()
  })

  it("rejects a slot name smuggled onto an OAuth kind", async () => {
    // Silently ignoring it would mint a canva link while the caller believed
    // it had asked for a credential-entry link.
    const response = await POST(
      request({ kind: "canva", name: "freshservice_api_key" })
    )
    expect(response.status).toBe(400)
    expect(signConsentTokenMock).not.toHaveBeenCalled()
  })

  it("still requires a signed owner context", async () => {
    contextOwner = null
    const response = await POST(
      request({ kind: "credential_entry", name: "freshservice_api_key" })
    )
    expect(response.status).toBe(403)
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("rejects a body-selected victim", async () => {
    const response = await POST(
      request({
        kind: "credential_entry",
        name: "freshservice_api_key",
        ownerEmail: "victim@psd401.net",
      })
    )
    expect(response.status).toBe(400)
    expect(signConsentTokenMock).not.toHaveBeenCalled()
  })
})
