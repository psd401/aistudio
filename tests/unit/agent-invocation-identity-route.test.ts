/** @jest-environment node */

let contextOwner: string | null = "owner@psd401.net"

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () =>
    contextOwner
      ? {
          actorEmail: "actor@psd401.net",
          ownerEmail: contextOwner,
          mode: "consultation",
          sessionId: "session-id",
        }
      : null
  ),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ warn: jest.fn() }),
  generateRequestId: () => "request-id",
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/invocation-identity/route"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"

const verifyInvocationMock = jest.mocked(verifyAgentInvocationContext)

function request(): NextRequest {
  return { headers: { get: () => null } } as unknown as NextRequest
}

describe("agent invocation identity route", () => {
  beforeEach(() => {
    contextOwner = "owner@psd401.net"
    verifyInvocationMock.mockClear()
  })

  it("returns only the owner from the verified invocation context", async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ownerEmail: "owner@psd401.net" })
    expect(verifyInvocationMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        allowedModes: ["owner", "consultation", "scheduled", "email-task"],
      }
    )
  })

  it("rejects an invocation that the trusted verifier does not accept", async () => {
    contextOwner = null

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Forbidden" })
  })
})
