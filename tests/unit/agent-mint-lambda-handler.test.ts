/**
 * Isolated mint Lambda handler (#1232 confused-deputy hardening).
 *
 * Asserts op routing, typed-error → structured-code mapping, the not-provisioned
 * distinct outcome, and — the security-critical property — that the handler
 * forwards ONLY the caller's ownerEmail to the broker (the agnt_ derivation runs
 * INSIDE mintAgentWorkspaceToken), never a caller-injected target sub/agentEmail.
 */

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sanitizeForLogging: (x: unknown) => x,
}))

const mintMock = jest.fn()
jest.mock("@/lib/agent-workspace/dwd-token-broker", () => {
  class AccountNotProvisionedError extends Error {
    agentEmail: string
    constructor(agentEmail: string) {
      super(`Agent account ${agentEmail} is not provisioned yet`)
      this.name = "AccountNotProvisionedError"
      this.agentEmail = agentEmail
    }
  }
  class BrokerNotConfiguredError extends Error {}
  class InvalidOwnerError extends Error {}
  return {
    mintAgentWorkspaceToken: (...a: unknown[]) => mintMock(...a),
    AccountNotProvisionedError,
    BrokerNotConfiguredError,
    InvalidOwnerError,
  }
})

const ensureRowMock = jest.fn()
const createGatewayMock = jest.fn((..._a: unknown[]) => ({ gateway: true }))
jest.mock("@/lib/agent-workspace/agent-provisioning-sheet", () => {
  class ProvisioningNotConfiguredError extends Error {}
  return {
    ensureAgentUsernameRow: (...a: unknown[]) => ensureRowMock(...a),
    createSheetsGateway: (...a: unknown[]) => createGatewayMock(...a),
    ProvisioningNotConfiguredError,
  }
})

import { handleMintEvent } from "@/lib/agent-workspace/mint-lambda-handler"
import {
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"
import { ProvisioningNotConfiguredError } from "@/lib/agent-workspace/agent-provisioning-sheet"

beforeEach(() => {
  mintMock.mockReset()
  ensureRowMock.mockReset()
  createGatewayMock.mockClear()
})

describe("mint lambda handler — mint-token op", () => {
  it("returns accessToken/expiresAt/agentEmail on success", async () => {
    mintMock.mockResolvedValue({ accessToken: "ya29.at", expiresAt: "2026-07-15T01:00:00Z", agentEmail: "agnt_hagelk@psd401.net" })
    const r = await handleMintEvent({ op: "mint-token", ownerEmail: "hagelk@psd401.net" })
    expect(r).toEqual({ accessToken: "ya29.at", expiresAt: "2026-07-15T01:00:00Z", agentEmail: "agnt_hagelk@psd401.net" })
  })

  it("maps AccountNotProvisionedError to a distinct not-provisioned status (not an error)", async () => {
    mintMock.mockRejectedValue(new AccountNotProvisionedError("agnt_new@psd401.net"))
    const r = await handleMintEvent({ op: "mint-token", ownerEmail: "new@psd401.net" })
    expect(r).toEqual({ status: "account-not-provisioned", agentEmail: "agnt_new@psd401.net" })
  })

  it("maps InvalidOwnerError to code INVALID_OWNER", async () => {
    mintMock.mockRejectedValue(new InvalidOwnerError("ownerEmail domain must be psd401.net"))
    const r = await handleMintEvent({ op: "mint-token", ownerEmail: "x@gmail.com" })
    expect(r).toEqual({ error: "ownerEmail domain must be psd401.net", code: "INVALID_OWNER" })
  })

  it("maps BrokerNotConfiguredError to code BROKER_NOT_CONFIGURED", async () => {
    mintMock.mockRejectedValue(new BrokerNotConfiguredError("missing GCP_PROJECT_NUMBER"))
    const r = await handleMintEvent({ op: "mint-token", ownerEmail: "hagelk@psd401.net" })
    expect(r).toEqual({ error: "missing GCP_PROJECT_NUMBER", code: "BROKER_NOT_CONFIGURED" })
  })

  it("maps an unexpected failure to code INTERNAL", async () => {
    mintMock.mockRejectedValue(new Error("STS boom"))
    const r = await handleMintEvent({ op: "mint-token", ownerEmail: "hagelk@psd401.net" })
    expect(r).toEqual({ error: "STS boom", code: "INTERNAL" })
  })

  it("rejects a missing/empty ownerEmail with INVALID_OWNER and never calls the broker", async () => {
    const r = await handleMintEvent({ op: "mint-token" } as never)
    expect(r).toEqual({ error: "ownerEmail is required", code: "INVALID_OWNER" })
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("SECURITY: forwards ONLY ownerEmail to the broker — an injected target sub/agentEmail is ignored", async () => {
    mintMock.mockResolvedValue({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_hagelk@psd401.net" })
    // A malicious caller tries to smuggle a victim target alongside ownerEmail.
    await handleMintEvent({
      op: "mint-token",
      ownerEmail: "hagelk@psd401.net",
      sub: "victim@psd401.net",
      agentEmail: "agnt_victim@psd401.net",
    } as never)
    // The broker (which derives agnt_ itself) is called with the owner email only,
    // and with exactly ONE argument — no target address can cross the boundary.
    expect(mintMock).toHaveBeenCalledTimes(1)
    expect(mintMock).toHaveBeenCalledWith("hagelk@psd401.net")
  })
})

describe("mint lambda handler — provision-account op", () => {
  it("returns { written } on success", async () => {
    ensureRowMock.mockResolvedValue({ written: true })
    const r = await handleMintEvent({ op: "provision-account", username: "pratzm" })
    expect(r).toEqual({ written: true })
    expect(ensureRowMock).toHaveBeenCalledWith("pratzm", { gateway: true })
  })

  it("maps ProvisioningNotConfiguredError to code PROVISIONING_NOT_CONFIGURED", async () => {
    ensureRowMock.mockRejectedValue(new ProvisioningNotConfiguredError("no sheet id"))
    const r = await handleMintEvent({ op: "provision-account", username: "pratzm" })
    expect(r).toEqual({ error: "no sheet id", code: "PROVISIONING_NOT_CONFIGURED" })
  })

  it("rejects a missing/empty username with INTERNAL and never touches the sheet", async () => {
    const r = await handleMintEvent({ op: "provision-account" } as never)
    expect(r).toEqual({ error: "username is required", code: "INTERNAL" })
    expect(ensureRowMock).not.toHaveBeenCalled()
  })
})

describe("mint lambda handler — dispatch", () => {
  it("returns INTERNAL for an unknown op", async () => {
    const r = await handleMintEvent({ op: "delete-everything" } as never)
    expect(r).toEqual({ error: "Unknown mint op: delete-everything", code: "INTERNAL" })
    expect(mintMock).not.toHaveBeenCalled()
    expect(ensureRowMock).not.toHaveBeenCalled()
  })
})
