jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () => ({
    actorEmail: "owner@psd401.net",
    ownerEmail: "owner@psd401.net",
    mode: "owner",
  })),
}))
jest.mock("@/lib/agent-workspace/mint-client", () => ({
  mintAgentWorkspaceTokenViaBoundary: jest.fn(),
}))
jest.mock("@/lib/agent-workspace/dwd-token-broker", () => ({
  AccountNotProvisionedError: class AccountNotProvisionedError extends Error {},
  InvalidOwnerError: class InvalidOwnerError extends Error {},
}))
jest.mock("@/lib/agent/workspace-token", () => ({
  getFreshAccessTokenForUser: jest.fn(),
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
import { POST } from "@/app/api/agent/workspace-execute/route"

function request(body: unknown): NextRequest {
  return {
    json: async () => body,
  } as unknown as NextRequest
}

describe("POST /api/agent/workspace-execute validator errors", () => {
  it("returns structured operation details for an operation allowlist rejection", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: ["drive", "files", "delete"],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Workspace operation is not allowed: drive files delete",
      reason: "operation_not_allowed",
      operation: "drive files delete",
    })
  })

  it("structures other validator rejections without leaking resource state", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: ["sheets", "+read", "get"],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error:
        "Workspace read command contains a mutation operation: helper verb `+read` is not permitted; use the canonical read action (e.g. `sheets spreadsheets values get`)",
      reason: "workspace_command_rejected",
      operation: "sheets +read get",
    })
  })

  it("bounds the operation diagnostic after oversized argument rejection", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: ["X".repeat(1_000_000)],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Workspace command contains an invalid argument",
      reason: "workspace_command_rejected",
      operation: "<operation-too-long>",
    })
  })

  it("rejects a within-limit oversized operation before normalization", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: ["X".repeat(200_000), "objects", "delete"],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Workspace command contains an invalid operation",
      reason: "workspace_command_rejected",
      operation: "<operation-too-long>",
    })
  })

  it("does not reflect an oversized helper verb in a generic error", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: ["gmail", `+${"A".repeat(199_999)}`, "get"],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Workspace command contains an invalid operation",
      reason: "workspace_command_rejected",
      operation: "<operation-too-long>",
    })
  })

  it("uses a meaningful sentinel for a flag-first invalid command", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: ["--help"],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Workspace command must name a service and operation",
      reason: "workspace_command_rejected",
      operation: "<operation-unavailable>",
    })
  })
})

/**
 * The gate exemptions that ask "is the recipient the person who asked?" are
 * only reachable if the validator is told who asked.
 *
 * #1636 shipped the Drive ownership transfer with four unit tests that called
 * the validator directly and passed the caller. The ROUTE did not: it ran a
 * pre-check with `ownerEmail` undefined, so `isShareToCaller` could not match,
 * the request fell through to the third-party allowlist, and `role: "owner"`
 * was refused with 400 before `executeWorkspaceCommand` — which does pass the
 * caller — was ever reached. The capability was documented as working and was
 * dead on every live path (dev agent_failures 496).
 *
 * These assert through POST, so they fail if the wiring regresses even while
 * the validator's own tests still pass.
 */
describe("POST /api/agent/workspace-execute forwards the caller to the gate", () => {
  const SHARE_REFUSAL =
    "Drive shares are limited to the requesting user, an in-district named person (reader/commenter/writer), or a domain-wide reader"

  it("does not refuse an ownership transfer to the caller", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: [
          "drive",
          "permissions",
          "create",
          "--params",
          JSON.stringify({ fileId: "FILE123", transferOwnership: true }),
          "--json",
          JSON.stringify({
            type: "user",
            role: "owner",
            emailAddress: "owner@psd401.net",
          }),
        ],
      })
    )

    // Downstream token minting is mocked and will fail; all this pins is that
    // the command got PAST validation, which is where it used to die.
    const body = (await response.json()) as { error?: string }
    expect(body.error).not.toBe(SHARE_REFUSAL)
  })

  it("still refuses an ownership transfer to a third party", async () => {
    const response = await POST(
      request({
        scope: "agent",
        argv: [
          "drive",
          "permissions",
          "create",
          "--json",
          JSON.stringify({
            fileId: "FILE123",
            type: "user",
            role: "owner",
            emailAddress: "someone.else@psd401.net",
            transferOwnership: true,
          }),
        ],
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: SHARE_REFUSAL,
    })
  })
})
