/**
 * POST /api/agent/workspace-token — broker route guards + outcomes (#1232).
 *
 * Drives the real handler with a mocked internal-auth check and a mocked broker,
 * asserting: bad PSK -> 401, bad email -> 400, success -> {accessToken,expiresAt},
 * account-not-provisioned -> 404 {status}, not-configured -> 503, other -> 502,
 * and the per-owner rate limit -> 429.
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

// Real error classes, mocked mint.
const mintMock = jest.fn()
jest.mock("@/lib/agent-workspace/dwd-token-broker", () => {
  class AccountNotProvisionedError extends Error {}
  class BrokerNotConfiguredError extends Error {}
  class InvalidOwnerError extends Error {}
  return {
    mintAgentWorkspaceToken: (...a: unknown[]) => mintMock(...a),
    AccountNotProvisionedError,
    BrokerNotConfiguredError,
    InvalidOwnerError,
  }
})

import { POST } from "@/app/api/agent/workspace-token/route"
import { resetAgentWorkspaceTokenRateLimitForTests } from "@/lib/agent-workspace/token-rate-limit"
import {
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
} from "@/lib/agent-workspace/dwd-token-broker"

function req(body: unknown): NextRequest {
  return {
    headers: { get: () => "Bearer x" },
    json: async () => body,
  } as unknown as NextRequest
}
import type { NextRequest } from "next/server"

beforeEach(() => {
  authOk = true
  mintMock.mockReset()
  resetAgentWorkspaceTokenRateLimitForTests()
})

describe("POST /api/agent/workspace-token", () => {
  it("401s a bad shared secret", async () => {
    authOk = false
    const res = await POST(req({ ownerEmail: "hagelk@psd401.net" }))
    expect(res.status).toBe(401)
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("400s a malformed ownerEmail", async () => {
    const res = await POST(req({ ownerEmail: "not-an-email" }))
    expect(res.status).toBe(400)
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("400s (not 500) a null JSON body", async () => {
    const res = await POST(req(null))
    expect(res.status).toBe(400)
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("returns accessToken + expiresAt on success", async () => {
    mintMock.mockResolvedValue({ accessToken: "ya29.at", expiresAt: "2026-07-14T01:00:00.000Z", agentEmail: "agnt_hagelk@psd401.net" })
    const res = await POST(req({ ownerEmail: "hagelk@psd401.net" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accessToken: "ya29.at", expiresAt: "2026-07-14T01:00:00.000Z" })
    expect(mintMock).toHaveBeenCalledWith("hagelk@psd401.net")
  })

  it("404s account-not-provisioned distinctly", async () => {
    mintMock.mockRejectedValue(new AccountNotProvisionedError("agnt_new@psd401.net"))
    const res = await POST(req({ ownerEmail: "new@psd401.net" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: "account-not-provisioned" })
  })

  it("503s when the broker is not configured", async () => {
    mintMock.mockRejectedValue(new BrokerNotConfiguredError("missing GCP_PROJECT_NUMBER"))
    const res = await POST(req({ ownerEmail: "hagelk@psd401.net" }))
    expect(res.status).toBe(503)
  })

  it("502s an unexpected broker failure", async () => {
    mintMock.mockRejectedValue(new Error("STS boom"))
    const res = await POST(req({ ownerEmail: "hagelk@psd401.net" }))
    expect(res.status).toBe(502)
  })

  it("429s after the per-owner hourly cap is exceeded", async () => {
    mintMock.mockResolvedValue({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_h@psd401.net" })
    // Default cap is 120/hour; drive one owner past it.
    let last: Response | undefined
    for (let i = 0; i < 121; i++) {
      last = await POST(req({ ownerEmail: "heavy@psd401.net" }))
    }
    expect(last!.status).toBe(429)
  })

  it("cannot bypass the rate limit by case-shuffling the same owner email", async () => {
    mintMock.mockResolvedValue({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_h@psd401.net" })
    let last: Response | undefined
    for (let i = 0; i < 121; i++) {
      const shuffled = i % 2 === 0 ? "Heavy@psd401.net" : "heavy@PSD401.net"
      last = await POST(req({ ownerEmail: shuffled }))
    }
    expect(last!.status).toBe(429)
    // Normalized to a single rate-limit key + broker call, regardless of input casing.
    expect(mintMock).toHaveBeenCalledWith("heavy@psd401.net")
  })
})
