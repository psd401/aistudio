import type { NextRequest } from "next/server"
import { createHmac, randomUUID } from "node:crypto"
import {
  AGENT_INVOCATION_CONTEXT_HEADER,
  AGENT_REQUEST_PROOF_BODY_SHA256_HEADER,
  AGENT_REQUEST_PROOF_NONCE_HEADER,
  AGENT_REQUEST_PROOF_SIGNATURE_HEADER,
  AGENT_REQUEST_PROOF_TIMESTAMP_HEADER,
  AGENT_REQUEST_PROOF_VERSION_HEADER,
  verifyAgentInvocationContext,
} from "@/lib/agent-workspace/invocation-context"
import {
  createAgentRequestProof,
  deriveInvocationRequestProofKey,
} from "@/infra/lambdas/agent-router/invocation-context"

const SECRET = "0123456789abcdef0123456789abcdef"
const ROUTE = "/api/agent/credentials"
const BODY = JSON.stringify({ operation: "check-skill-access", capability: "x" })

function token(
  overrides: Partial<{
    actorEmail: string
    ownerEmail: string
    mode: "owner" | "consultation" | "scheduled" | "email-task"
    issuedAt: number
    expiresAt: number
    nonce: string
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
    nonce: "invocation-nonce-1",
    ...overrides,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = createHmac("sha256", SECRET)
    .update(`v1.${payload}`)
    .digest("base64url")
  return `v1.${payload}.${signature}`
}

function request(options: {
  context?: string
  body?: string
  route?: string
  method?: string
  timestamp?: number
  proofNonce?: string
  signRoute?: string
  signMethod?: string
  signBody?: string
  signature?: string
} = {}): NextRequest {
  const body = options.body ?? BODY
  const route = options.route ?? ROUTE
  const method = options.method ?? "POST"
  const timestamp = String(options.timestamp ?? 120)
  const nonce = options.proofNonce ?? randomUUID()
  const context = options.context ?? token()
  const proof = createAgentRequestProof(
    deriveInvocationRequestProofKey(SECRET, context),
    {
      method: options.signMethod ?? method,
      route: options.signRoute ?? route,
      body: options.signBody ?? body,
    },
    { timestamp: Number(timestamp), nonce }
  )
  const signature = options.signature ?? proof["X-Agent-Request-Proof-Signature"]
  const headers = new Map<string, string>([
    ["content-type", "application/json"],
    [AGENT_INVOCATION_CONTEXT_HEADER, context],
    [AGENT_REQUEST_PROOF_VERSION_HEADER, "v1"],
    [AGENT_REQUEST_PROOF_TIMESTAMP_HEADER, timestamp],
    [AGENT_REQUEST_PROOF_NONCE_HEADER, nonce],
    [
      AGENT_REQUEST_PROOF_BODY_SHA256_HEADER,
      proof["X-Agent-Request-Proof-Body-Sha256"],
    ],
    [AGENT_REQUEST_PROOF_SIGNATURE_HEADER, signature],
  ])
  const encodedBody = new TextEncoder().encode(body)
  return {
    headers,
    method,
    nextUrl: { pathname: route },
    clone: () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodedBody)
          controller.close()
        },
      }),
    }),
  } as unknown as NextRequest
}

describe("verifyAgentInvocationContext request authority", () => {
  type NonceInput = {
    nonce: string
    invocationNonce: string
    ownerEmail: string
    method: string
    route: string
    expiresAt: number
  }
  const consumed = jest.fn(async (_input: NonceInput) => true)

  beforeEach(() => {
    process.env.AGENT_INVOCATION_SIGNING_SECRET = SECRET
    consumed.mockClear()
  })

  afterEach(() => {
    delete process.env.AGENT_INVOCATION_SIGNING_SECRET
  })

  it("accepts a fresh proof bound to owner, method, route, and body", async () => {
    const signedRequest = request()
    const result = await verifyAgentInvocationContext(signedRequest, {
      nowSeconds: 120,
      allowedModes: ["owner"],
      consumeNonce: consumed,
    })
    expect(result).toMatchObject({
      ownerEmail: "owner@psd401.net",
      mode: "owner",
    })
    expect(consumed).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerEmail: "owner@psd401.net",
        method: "POST",
        route: ROUTE,
      })
    )
  })

  it.each([
    ["changed body", { body: "{}", signBody: BODY }],
    ["cross-route replay", { route: "/api/agent/canva", signRoute: ROUTE }],
    ["cross-method replay", { method: "PUT", signMethod: "POST" }],
    ["expired proof", { timestamp: 80 }],
    ["future proof", { timestamp: 160 }],
    ["invalid signature", { signature: "A".repeat(43) }],
  ])("rejects %s", async (_name, overrides) => {
    await expect(
      verifyAgentInvocationContext(request(overrides), {
        nowSeconds: 120,
        allowedModes: ["owner"],
        consumeNonce: consumed,
      })
    ).resolves.toBeNull()
    expect(consumed).not.toHaveBeenCalled()
  })

  it("rejects duplicate nonces atomically", async () => {
    const seen = new Set<string>()
    const atomicConsumer = jest.fn(async ({ nonce }: NonceInput) => {
      if (seen.has(nonce)) return false
      seen.add(nonce)
      return true
    })
    const proofNonce = randomUUID()
    const first = await verifyAgentInvocationContext(request({ proofNonce }), {
      nowSeconds: 120,
      consumeNonce: atomicConsumer,
    })
    const replay = await verifyAgentInvocationContext(request({ proofNonce }), {
      nowSeconds: 120,
      consumeNonce: atomicConsumer,
    })
    expect(first).not.toBeNull()
    expect(replay).toBeNull()
  })

  it("rejects a stolen context without the derived proof", async () => {
    const stolen = request()
    stolen.headers.delete(AGENT_REQUEST_PROOF_SIGNATURE_HEADER)
    await expect(
      verifyAgentInvocationContext(stolen, {
        nowSeconds: 120,
        consumeNonce: consumed,
      })
    ).resolves.toBeNull()
  })

  it("keeps concurrent owners bound to their own proof keys", async () => {
    const ownerOne = request()
    const ownerTwoContext = token({
      actorEmail: "other@psd401.net",
      ownerEmail: "other@psd401.net",
      nonce: "invocation-nonce-2",
    })
    const ownerTwo = request({
      context: ownerTwoContext,
    })
    const [one, two] = await Promise.all([
      verifyAgentInvocationContext(ownerOne, {
        nowSeconds: 120,
        consumeNonce: consumed,
      }),
      verifyAgentInvocationContext(ownerTwo, {
        nowSeconds: 120,
        consumeNonce: consumed,
      }),
    ])
    expect(one?.ownerEmail).toBe("owner@psd401.net")
    expect(two?.ownerEmail).toBe("other@psd401.net")
  })
})
