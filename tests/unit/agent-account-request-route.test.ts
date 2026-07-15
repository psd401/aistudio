/**
 * POST /api/agent/account-request — provisioning endpoint (#1233).
 *
 * Drives the real handler with mocked auth/broker/sheet, asserting: bad PSK ->
 * 401, bad email -> 400, numeric-prefix (student) -> 400, account exists ->
 * {status:"active"}, not-provisioned -> sheet write -> {status:"requested"},
 * broker-not-configured -> 503.
 */

let authOk = true
jest.mock("@/lib/agent-workspace/internal-auth", () => ({
  validateInternalSecret: jest.fn(async () => authOk),
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
    loadBrokerConfig: jest.fn(() => ({ allowedDomain: "psd401.net" })),
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
  return { headers: { get: () => "Bearer x" }, json: async () => body } as unknown as NextRequest
}

beforeEach(() => {
  authOk = true
  mintMock.mockReset()
  ensureRowMock.mockClear()
  ensureRowMock.mockResolvedValue({ written: true })
})

describe("POST /api/agent/account-request", () => {
  it("401s a bad shared secret", async () => {
    authOk = false
    expect((await POST(req({ ownerEmail: "hagelk@psd401.net" }))).status).toBe(401)
  })

  it("400s a malformed email", async () => {
    expect((await POST(req({ ownerEmail: "nope" }))).status).toBe(400)
  })

  it("400s (not 500) a null JSON body", async () => {
    expect((await POST(req(null))).status).toBe(400)
  })

  it("400s a numeric-prefix (student) username and never touches the sheet", async () => {
    const res = await POST(req({ ownerEmail: "1234567@psd401.net" }))
    expect(res.status).toBe(400)
    expect(mintMock).not.toHaveBeenCalled()
    expect(ensureRowMock).not.toHaveBeenCalled()
  })

  it('returns {status:"active"} when the probe mints a token (account exists)', async () => {
    mintMock.mockResolvedValue({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_hagelk@psd401.net" })
    const res = await POST(req({ ownerEmail: "hagelk@psd401.net" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "active" })
    expect(ensureRowMock).not.toHaveBeenCalled() // no sheet write when already active
  })

  it('writes to the sheet and returns {status:"requested"} when not provisioned', async () => {
    mintMock.mockRejectedValue(new AccountNotProvisionedError("agnt_hagelk@psd401.net"))
    const res = await POST(req({ ownerEmail: "hagelk@psd401.net" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "requested" })
    expect(ensureRowMock).toHaveBeenCalledWith("hagelk", expect.anything())
  })

  it("503s when the broker is not configured", async () => {
    mintMock.mockRejectedValue(new BrokerNotConfiguredError("missing GCP config"))
    expect((await POST(req({ ownerEmail: "hagelk@psd401.net" }))).status).toBe(503)
  })

  it("502s an unexpected probe error", async () => {
    mintMock.mockRejectedValue(new Error("STS boom"))
    expect((await POST(req({ ownerEmail: "hagelk@psd401.net" }))).status).toBe(502)
  })
})
