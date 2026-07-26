import { NextRequest } from "next/server"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { lt } from "drizzle-orm"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { psdAgentRequestNonces } from "@/lib/db/schema"

export const AGENT_INVOCATION_CONTEXT_HEADER = "x-agent-invocation-context"
export const AGENT_REQUEST_PROOF_VERSION_HEADER = "x-agent-request-proof-version"
export const AGENT_REQUEST_PROOF_TIMESTAMP_HEADER = "x-agent-request-proof-timestamp"
export const AGENT_REQUEST_PROOF_NONCE_HEADER = "x-agent-request-proof-nonce"
export const AGENT_REQUEST_PROOF_BODY_SHA256_HEADER = "x-agent-request-proof-body-sha256"
export const AGENT_REQUEST_PROOF_SIGNATURE_HEADER = "x-agent-request-proof-signature"
export const AGENT_INVOCATION_CONTEXT_AUDIENCE = "psd-agent-internal"
// Interactive contexts still default to 15 minutes at the trusted issuer.
// The verifier permits the bounded two-hour job-runner ceiling so a promoted
// AgentCore turn does not lose broker authority partway through execution.
const MAX_TOKEN_TTL_SECONDS = 2 * 60 * 60
const MAX_CLOCK_SKEW_SECONDS = 30
const REQUEST_PROOF_VERSION = "v1"
const MAX_PROOF_BODY_BYTES = 32 * 1024 * 1024
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AgentInvocationMode =
  | "owner"
  | "consultation"
  | "scheduled"
  | "email-task"

export interface AgentInvocationContext {
  version: 1
  audience: typeof AGENT_INVOCATION_CONTEXT_AUDIENCE
  actorEmail: string
  ownerEmail: string
  mode: AgentInvocationMode
  sessionId: string
  workspacePrefix: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

function isInvocationMode(value: unknown): value is AgentInvocationMode {
  return (
    value === "owner" ||
    value === "consultation" ||
    value === "scheduled" ||
    value === "email-task"
  )
}

function isValidClaims(value: unknown): value is AgentInvocationContext {
  if (!value || typeof value !== "object") return false
  const claims = value as Partial<AgentInvocationContext>
  return (
    claims.version === 1 &&
    claims.audience === AGENT_INVOCATION_CONTEXT_AUDIENCE &&
    typeof claims.actorEmail === "string" &&
    SAFE_EMAIL_RE.test(claims.actorEmail) &&
    claims.actorEmail === claims.actorEmail.toLowerCase() &&
    typeof claims.ownerEmail === "string" &&
    SAFE_EMAIL_RE.test(claims.ownerEmail) &&
    claims.ownerEmail === claims.ownerEmail.toLowerCase() &&
    isInvocationMode(claims.mode) &&
    typeof claims.sessionId === "string" &&
    claims.sessionId.length > 0 &&
    claims.sessionId.length <= 512 &&
    typeof claims.workspacePrefix === "string" &&
    claims.workspacePrefix.length <= 512 &&
    Number.isInteger(claims.issuedAt) &&
    Number.isInteger(claims.expiresAt) &&
    typeof claims.nonce === "string" &&
    claims.nonce.length > 0 &&
    claims.nonce.length <= 128
  )
}

async function getInvocationSigningSecret(): Promise<string | null> {
  const envValue = process.env.AGENT_INVOCATION_SIGNING_SECRET
  if (envValue) return envValue

  const secretId = process.env.AGENT_INVOCATION_SIGNING_SECRET_ID
  if (!secretId) return null
  return getSecretString(secretId)
}

function deriveRequestProofKey(secret: string, invocationNonce: string): Buffer {
  return createHmac("sha256", secret)
    .update(`agent-request-proof:v1:${invocationNonce}`)
    .digest()
}

function canonicalRequestProof(input: {
  timestamp: string
  nonce: string
  method: string
  route: string
  bodySha256: string
}): string {
  return [
    REQUEST_PROOF_VERSION,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.route,
    input.bodySha256,
  ].join("\n")
}

async function consumeRequestNonce(input: {
  nonce: string
  invocationNonce: string
  ownerEmail: string
  method: string
  route: string
  expiresAt: number
}): Promise<boolean> {
  return executeTransaction(async (tx) => {
    const now = new Date()
    await tx
      .delete(psdAgentRequestNonces)
      .where(lt(psdAgentRequestNonces.expiresAt, now))
    const inserted = await tx
      .insert(psdAgentRequestNonces)
      .values({
        nonce: input.nonce,
        invocationNonce: input.invocationNonce,
        ownerEmail: input.ownerEmail,
        method: input.method,
        route: input.route,
        expiresAt: new Date(input.expiresAt * 1000),
      })
      .onConflictDoNothing({ target: psdAgentRequestNonces.nonce })
      .returning({ nonce: psdAgentRequestNonces.nonce })
    return inserted.length === 1
  }, "consumeAgentRequestNonce")
}

async function hashBoundedRequestBody(request: NextRequest): Promise<string | null> {
  const rawContentLength = request.headers.get("content-length")
  if (rawContentLength) {
    const contentLength = Number(rawContentLength)
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_PROOF_BODY_BYTES
    ) {
      return null
    }
  }
  const body = request.clone().body
  const hash = createHash("sha256")
  if (!body) return hash.digest("hex")

  const reader = body.getReader()
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_PROOF_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      hash.update(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  return hash.digest("hex")
}

/**
 * Verify the router-issued owner context. A valid token is authorization data,
 * not merely identity metadata: privileged routes must derive the owner from
 * this object and reject any conflicting body selector.
 */
export async function verifyAgentInvocationContext(
  request: NextRequest,
  options: {
    nowSeconds?: number
    allowedModes?: readonly AgentInvocationMode[]
    consumeNonce?: typeof consumeRequestNonce
  } = {}
): Promise<AgentInvocationContext | null> {
  const token = request.headers.get(AGENT_INVOCATION_CONTEXT_HEADER)
  if (!token || token.length > 4096) return null

  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null

  const secret = await getInvocationSigningSecret()
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return null

  const expected = createHmac("sha256", secret)
    .update(`v1.${parts[1]}`)
    .digest()
  let provided: Buffer
  try {
    provided = Buffer.from(parts[2], "base64url")
  } catch {
    return null
  }
  if (provided.length !== expected.length) {
    timingSafeEqual(expected, expected)
    return null
  }
  if (!timingSafeEqual(provided, expected)) return null

  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!isValidClaims(claims)) return null

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (claims.issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return null
  if (claims.expiresAt < nowSeconds - MAX_CLOCK_SKEW_SECONDS) return null
  if (claims.expiresAt <= claims.issuedAt) return null
  if (claims.expiresAt - claims.issuedAt > MAX_TOKEN_TTL_SECONDS) return null
  if (options.allowedModes && !options.allowedModes.includes(claims.mode)) return null

  const proofVersion = request.headers.get(AGENT_REQUEST_PROOF_VERSION_HEADER)
  const proofTimestamp = request.headers.get(AGENT_REQUEST_PROOF_TIMESTAMP_HEADER)
  const proofNonce = request.headers.get(AGENT_REQUEST_PROOF_NONCE_HEADER)
  const proofBodySha256 = request.headers.get(
    AGENT_REQUEST_PROOF_BODY_SHA256_HEADER
  )
  const proofSignature = request.headers.get(AGENT_REQUEST_PROOF_SIGNATURE_HEADER)
  if (
    proofVersion !== REQUEST_PROOF_VERSION ||
    !proofTimestamp ||
    !proofNonce ||
    !UUID_RE.test(proofNonce) ||
    !proofBodySha256 ||
    !SHA256_HEX_RE.test(proofBodySha256) ||
    !proofSignature
  ) {
    return null
  }
  const timestamp = Number(proofTimestamp)
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(timestamp - nowSeconds) > MAX_CLOCK_SKEW_SECONDS ||
    timestamp < claims.issuedAt - MAX_CLOCK_SKEW_SECONDS ||
    timestamp > claims.expiresAt + MAX_CLOCK_SKEW_SECONDS
  ) {
    return null
  }
  const method = request.method.toUpperCase()
  const route = request.nextUrl.pathname
  const actualBodySha256 = await hashBoundedRequestBody(request)
  if (!actualBodySha256 || actualBodySha256 !== proofBodySha256) return null

  const expectedProof = createHmac(
    "sha256",
    deriveRequestProofKey(secret, claims.nonce)
  )
    .update(
      canonicalRequestProof({
        timestamp: proofTimestamp,
        nonce: proofNonce,
        method,
        route,
        bodySha256: proofBodySha256,
      })
    )
    .digest()
  let providedProof: Buffer
  try {
    providedProof = Buffer.from(proofSignature, "base64url")
  } catch {
    return null
  }
  if (providedProof.length !== expectedProof.length) {
    timingSafeEqual(expectedProof, expectedProof)
    return null
  }
  if (!timingSafeEqual(providedProof, expectedProof)) return null

  const consumed = await (options.consumeNonce ?? consumeRequestNonce)({
    nonce: proofNonce,
    invocationNonce: claims.nonce,
    ownerEmail: claims.ownerEmail,
    method,
    route,
    expiresAt: claims.expiresAt + MAX_CLOCK_SKEW_SECONDS,
  })
  if (!consumed) return null

  return claims
}
