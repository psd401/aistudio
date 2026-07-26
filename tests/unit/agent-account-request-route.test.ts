/**
 * POST /api/agent/account-request — provisioning endpoint (#1233).
 *
 * Drives the real handler with mocked context/broker/sheet, asserting owner
 * selectors -> 400, numeric-prefix (student) -> 400, account exists ->
 * {status:"active"}, not-provisioned -> sheet write -> {status:"requested"},
 * broker-not-configured -> 503.
 */

let contextOwner: string | null = "hagelk@psd401.net"
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
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sanitizeForLogging: (x: unknown) => x,
  generateRequestId: () => "rid-test",
}))

const mintMock = jest.fn()
jest.mock("@/lib/agent-workspace/dwd-token-broker", () => {
  class AccountNotProvisionedError extends Error {}
  class BrokerNotConfiguredError extends Error {}
  class InvalidOwnerError extends Error {}
  return {
    mintAgentWorkspaceToken: (...a: unknown[]) => mintMock(...a),
    deriveAgentEmail: jest.fn(() => "agnt_hagelk@psd401.net"),
    loadBrokerConfig: jest.fn(async () => ({ allowedDomain: "psd401.net" })),
    AccountNotProvisionedError,
    BrokerNotConfiguredError,
    InvalidOwnerError,
  }
})

const ensureRowMock = jest.fn(async (..._a: unknown[]) => ({ written: true }))
jest.mock("@/lib/agent-workspace/agent-provisioning-sheet", () => {
  class ProvisioningNotConfiguredError extends Error {}
  return {
    ensureAgentUsernameRow: (...a: unknown[]) => ensureRowMock(...a),
    createSheetsGateway: jest.fn(() => ({})),
    ProvisioningNotConfiguredError,
  }
})

import { POST } from "@/app/api/agent/account-request/route"
import { AccountNotProvisionedError, BrokerNotConfiguredError } from "@/lib/agent-workspace/dwd-token-broker"
import type { NextRequest } from "next/server"

function req(body: unknown): NextRequest {
  return { headers: { get: () => null }, json: async () => body } as unknown as NextRequest
}

beforeEach(() => {
  contextOwner = "hagelk@psd401.net"
  mintMock.mockReset()
  ensureRowMock.mockClear()
  ensureRowMock.mockResolvedValue({ written: true })
})

describe("POST /api/agent/account-request", () => {
  it("rejects all body-supplied owner selectors", async () => {
    expect((await POST(req({ ownerEmail: "nope" }))).status).toBe(400)
  })

  it("403s when there is no signed owner context", async () => {
    contextOwner = null
    const res = await POST(req({}))
    expect(res.status).toBe(403)
    expect(mintMock).not.toHaveBeenCalled()
    expect(ensureRowMock).not.toHaveBeenCalled()
  })

  it("rejects cross-owner provisioning selectors before broker or sheet access", async () => {
    const res = await POST(req({ ownerEmail: "victim@psd401.net" }))
    expect(res.status).toBe(400)
    expect(mintMock).not.toHaveBeenCalled()
    expect(ensureRowMock).not.toHaveBeenCalled()
  })

  it("400s (not 500) a null JSON body", async () => {
    expect((await POST(req(null))).status).toBe(400)
  })

  it("400s a numeric-prefix (student) username and never touches the sheet", async () => {
    contextOwner = "1234567@psd401.net"
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(mintMock).not.toHaveBeenCalled()
    expect(ensureRowMock).not.toHaveBeenCalled()
  })

  it('returns {status:"active"} when the probe mints a token (account exists)', async () => {
    mintMock.mockResolvedValue({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_hagelk@psd401.net" })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "active" })
    expect(ensureRowMock).not.toHaveBeenCalled() // no sheet write when already active
  })

  it('writes to the sheet and returns {status:"requested"} when not provisioned', async () => {
    mintMock.mockRejectedValue(new AccountNotProvisionedError("agnt_hagelk@psd401.net"))
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "requested" })
    expect(ensureRowMock).toHaveBeenCalledWith("hagelk", expect.anything())
  })

  it("503s when the broker is not configured", async () => {
    mintMock.mockRejectedValue(new BrokerNotConfiguredError("missing GCP config"))
    expect((await POST(req({}))).status).toBe(503)
  })

  it("502s an unexpected probe error", async () => {
    mintMock.mockRejectedValue(new Error("STS boom"))
    expect((await POST(req({}))).status).toBe(502)
  })
})
