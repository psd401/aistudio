import type { NextRequest } from "next/server"
import { createHmac } from "node:crypto"
import {
  AGENT_INVOCATION_CONTEXT_HEADER,
  verifyAgentInvocationContext,
} from "@/lib/agent-workspace/invocation-context"
import { createScheduledInvocationContextToken } from "@/infra/lambdas/agent-cron/invocation-context"

const SECRET = "0123456789abcdef0123456789abcdef"

function token(
  overrides: Partial<{
    actorEmail: string
    ownerEmail: string
    mode: "owner" | "consultation" | "scheduled"
    issuedAt: number
    expiresAt: number
  }> = {}
): string {
  const claims = {
    version: 1,
    audience: "psd-agent-internal",
    actorEmail: "owner@psd401.net",
    ownerEmail: "owner@psd401.net",
    mode: "owner",
    sessionId: "session-1",
    workspacePrefix: "users/owner/",
    issuedAt: 100,
    expiresAt: 160,
    nonce: "nonce-1",
    ...overrides,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = createHmac("sha256", SECRET)
    .update(`v1.${payload}`)
    .digest("base64url")
  return `v1.${payload}.${signature}`
}

function request(value: string): NextRequest {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === AGENT_INVOCATION_CONTEXT_HEADER ? value : null,
    },
  } as unknown as NextRequest
}

describe("verifyAgentInvocationContext", () => {
  beforeEach(() => {
    process.env.AGENT_INVOCATION_SIGNING_SECRET = SECRET
  })

  afterEach(() => {
    delete process.env.AGENT_INVOCATION_SIGNING_SECRET
  })

  it("accepts a valid current owner context", async () => {
    await expect(
      verifyAgentInvocationContext(request(token()), {
        nowSeconds: 120,
        allowedModes: ["owner"],
      })
    ).resolves.toMatchObject({
      actorEmail: "owner@psd401.net",
      ownerEmail: "owner@psd401.net",
      mode: "owner",
    })
  })

  it("accepts a current scheduled context issued by the cron boundary", async () => {
    const scheduled = createScheduledInvocationContextToken(
      SECRET,
      {
        ownerEmail: "Owner@PSD401.NET",
        sessionId: "schedule-1",
        workspacePrefix: "users/owner/",
      },
      { nowSeconds: 100, ttlSeconds: 60, nonce: "nonce-scheduled" }
    )
    await expect(
      verifyAgentInvocationContext(request(scheduled), {
        nowSeconds: 120,
        allowedModes: ["owner", "scheduled"],
      })
    ).resolves.toMatchObject({
      actorEmail: "owner@psd401.net",
      ownerEmail: "owner@psd401.net",
      mode: "scheduled",
    })
  })

  it("rejects signature tampering, expiry, and consultation-mode replay", async () => {
    const valid = token()
    const [version, payload, signature] = valid.split(".")
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))
    decoded.ownerEmail = "victim@psd401.net"
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url")

    await expect(
      verifyAgentInvocationContext(
        request(`${version}.${tamperedPayload}.${signature}`),
        { nowSeconds: 120, allowedModes: ["owner"] }
      )
    ).resolves.toBeNull()
    await expect(
      verifyAgentInvocationContext(request(token({ expiresAt: 50 })), {
        nowSeconds: 100,
        allowedModes: ["owner"],
      })
    ).resolves.toBeNull()
    await expect(
      verifyAgentInvocationContext(request(token({ mode: "consultation" })), {
        nowSeconds: 120,
        allowedModes: ["owner"],
      })
    ).resolves.toBeNull()
  })
})
