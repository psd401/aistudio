/**
 * Frontend → mint Lambda invoker (#1232 confused-deputy hardening).
 *
 * Asserts the two modes of the boundary:
 *   - Lambda mode (AGENT_MINT_LAMBDA_NAME set — every deployed env): the helper
 *     invokes the mint Lambda via an IAM-authed InvokeCommand, translates the
 *     structured result back into the SAME typed errors the routes map, and
 *     — the security-critical property — NEVER runs the WIF broker/sheet
 *     in-process.
 *   - In-process fallback (env unset — local dev/tests): the helper calls the
 *     shared broker/sheet directly and never touches the Lambda SDK.
 */

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

const sendMock = jest.fn()
const invokeCommandMock = jest.fn((input: unknown) => ({ input }))
const lambdaClientCtor = jest.fn(() => ({ send: sendMock }))
jest.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: lambdaClientCtor,
  InvokeCommand: invokeCommandMock,
}))

import {
  mintAgentWorkspaceTokenViaBoundary,
  provisionAgentAccountViaBoundary,
  __resetMintClientForTests,
} from "@/lib/agent-workspace/mint-client"
import {
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"
import { ProvisioningNotConfiguredError } from "@/lib/agent-workspace/agent-provisioning-sheet"

/** Decode the InvokeCommand payload the client sent (Buffer → parsed JSON). */
function sentPayload(callIndex = 0): { FunctionName: string; InvocationType: string; op: string; [k: string]: unknown } {
  const input = invokeCommandMock.mock.calls[callIndex][0] as {
    FunctionName: string
    InvocationType: string
    Payload: Uint8Array
  }
  const parsed = JSON.parse(Buffer.from(input.Payload).toString("utf8")) as Record<string, unknown>
  return { FunctionName: input.FunctionName, InvocationType: input.InvocationType, ...parsed } as never
}

function lambdaReplies(response: unknown): void {
  sendMock.mockResolvedValue({ Payload: Buffer.from(JSON.stringify(response)) })
}

const ORIGINAL_ENV = process.env.AGENT_MINT_LAMBDA_NAME

beforeEach(() => {
  mintMock.mockReset()
  ensureRowMock.mockReset()
  createGatewayMock.mockClear()
  sendMock.mockReset()
  invokeCommandMock.mockClear()
  lambdaClientCtor.mockClear()
  __resetMintClientForTests()
})
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AGENT_MINT_LAMBDA_NAME
  else process.env.AGENT_MINT_LAMBDA_NAME = ORIGINAL_ENV
})

describe("mint-client — Lambda mode (AGENT_MINT_LAMBDA_NAME set)", () => {
  beforeEach(() => {
    process.env.AGENT_MINT_LAMBDA_NAME = "psd-agent-mint-dev"
  })

  it("invokes the mint Lambda for a token and NEVER runs WIF in-process", async () => {
    lambdaReplies({ accessToken: "ya29.at", expiresAt: "2026-07-15T01:00:00Z", agentEmail: "agnt_hagelk@psd401.net" })
    const minted = await mintAgentWorkspaceTokenViaBoundary("hagelk@psd401.net")
    expect(minted).toEqual({ accessToken: "ya29.at", expiresAt: "2026-07-15T01:00:00Z", agentEmail: "agnt_hagelk@psd401.net" })
    // The isolated Lambda was invoked with the right FunctionName + RequestResponse.
    const p = sentPayload()
    expect(p.FunctionName).toBe("psd-agent-mint-dev")
    expect(p.InvocationType).toBe("RequestResponse")
    expect(p.op).toBe("mint-token")
    expect(p.ownerEmail).toBe("hagelk@psd401.net")
    // CRITICAL: the in-process broker (WIF/signJwt) did NOT run.
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("reconstructs AccountNotProvisionedError from a not-provisioned reply", async () => {
    lambdaReplies({ status: "account-not-provisioned", agentEmail: "agnt_new@psd401.net" })
    await expect(mintAgentWorkspaceTokenViaBoundary("new@psd401.net")).rejects.toBeInstanceOf(AccountNotProvisionedError)
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("reconstructs InvalidOwnerError from an INVALID_OWNER reply", async () => {
    lambdaReplies({ error: "ownerEmail domain must be psd401.net", code: "INVALID_OWNER" })
    await expect(mintAgentWorkspaceTokenViaBoundary("x@gmail.com")).rejects.toBeInstanceOf(InvalidOwnerError)
  })

  it("reconstructs BrokerNotConfiguredError from a BROKER_NOT_CONFIGURED reply", async () => {
    lambdaReplies({ error: "missing GCP config", code: "BROKER_NOT_CONFIGURED" })
    await expect(mintAgentWorkspaceTokenViaBoundary("hagelk@psd401.net")).rejects.toBeInstanceOf(BrokerNotConfiguredError)
  })

  it("throws a generic Error when the Lambda itself failed (FunctionError)", async () => {
    sendMock.mockResolvedValue({ FunctionError: "Unhandled", Payload: Buffer.from('{"errorMessage":"boom"}') })
    await expect(mintAgentWorkspaceTokenViaBoundary("hagelk@psd401.net")).rejects.toThrow(/FunctionError/)
  })

  it("invokes the mint Lambda for provisioning and NEVER writes the sheet in-process", async () => {
    lambdaReplies({ written: true })
    const r = await provisionAgentAccountViaBoundary("pratzm")
    expect(r).toEqual({ written: true })
    const p = sentPayload()
    expect(p.op).toBe("provision-account")
    expect(p.username).toBe("pratzm")
    expect(ensureRowMock).not.toHaveBeenCalled()
    expect(createGatewayMock).not.toHaveBeenCalled()
  })

  it("reconstructs ProvisioningNotConfiguredError from a provision error reply", async () => {
    lambdaReplies({ error: "no sheet id", code: "PROVISIONING_NOT_CONFIGURED" })
    await expect(provisionAgentAccountViaBoundary("pratzm")).rejects.toBeInstanceOf(ProvisioningNotConfiguredError)
  })
})

describe("mint-client — in-process fallback (env unset)", () => {
  beforeEach(() => {
    delete process.env.AGENT_MINT_LAMBDA_NAME
  })

  it("runs the broker in-process and never touches the Lambda SDK", async () => {
    mintMock.mockResolvedValue({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_hagelk@psd401.net" })
    const minted = await mintAgentWorkspaceTokenViaBoundary("hagelk@psd401.net")
    expect(minted).toEqual({ accessToken: "t", expiresAt: "x", agentEmail: "agnt_hagelk@psd401.net" })
    expect(mintMock).toHaveBeenCalledWith("hagelk@psd401.net")
    expect(invokeCommandMock).not.toHaveBeenCalled()
    expect(lambdaClientCtor).not.toHaveBeenCalled()
  })

  it("runs the sheet writer in-process and never touches the Lambda SDK", async () => {
    ensureRowMock.mockResolvedValue({ written: false })
    const r = await provisionAgentAccountViaBoundary("pratzm")
    expect(r).toEqual({ written: false })
    expect(ensureRowMock).toHaveBeenCalledWith("pratzm", { gateway: true })
    expect(invokeCommandMock).not.toHaveBeenCalled()
  })
})
