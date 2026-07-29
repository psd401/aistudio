/** @jest-environment node */

let contextOwner: string | null = "owner@psd401.net"

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () =>
    contextOwner
      ? {
          actorEmail: contextOwner,
          ownerEmail: contextOwner,
          mode: "owner",
          sessionId: "session-id",
        }
      : null
  ),
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/workspace-token/route"

function request(): NextRequest {
  return { headers: { get: () => null } } as unknown as NextRequest
}

describe("retired raw Workspace-token route", () => {
  beforeEach(() => {
    contextOwner = "owner@psd401.net"
  })

  it("still rejects unsigned requests", async () => {
    contextOwner = null
    expect((await POST(request())).status).toBe(403)
  })

  it("never returns a reusable token even to a signed model invocation", async () => {
    const response = await POST(request())
    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({
      error:
        "Raw Workspace tokens are not available. Use the Workspace operation broker.",
    })
  })
})
