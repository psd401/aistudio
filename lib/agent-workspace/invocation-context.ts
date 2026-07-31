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
// The verifier permits a bounded 2.5-hour job authority: model work remains
// capped at two hours, while the final 30 minutes cover cold start, privileged
// request drain, and durable workspace checkpointing.
export const MAX_AGENT_INVOCATION_CONTEXT_TTL_SECONDS = 150 * 60
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

function isNormalizedEmail(value: unknown): value is string {
  return (
    typeof value === "string"
    && SAFE_EMAIL_RE.test(value)
    && value === value.toLowerCase()
  )
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false
): value is string {
  if (typeof value !== "string") return false
  if (!allowEmpty && value.length === 0) return false
  return value.length <= maximumLength
}

function isValidClaims(value: unknown): value is AgentInvocationContext {
  if (!value || typeof value !== "object") return false
  const claims = value as Partial<AgentInvocationContext>
  return (
    claims.version === 1
    && claims.audience === AGENT_INVOCATION_CONTEXT_AUDIENCE
    && isNormalizedEmail(claims.actorEmail)
    && isNormalizedEmail(claims.ownerEmail)
    && isInvocationMode(claims.mode)
    && isBoundedString(claims.sessionId, 512)
    && isBoundedString(claims.workspacePrefix, 512, true)
    && Number.isInteger(claims.issuedAt)
    && Number.isInteger(claims.expiresAt)
    && isBoundedString(claims.nonce, 128)
  )
}

function decodeInvocationToken(
  token: string,
  secret: string
): AgentInvocationContext | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  if (parts[0] !== "v1" || !parts[1] || !parts[2]) return null

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
  return isValidClaims(claims) ? claims : null
}

function isCurrentInvocation(
  claims: AgentInvocationContext,
  nowSeconds: number,
  allowedModes: readonly AgentInvocationMode[] | undefined
): boolean {
  return (
    claims.issuedAt <= nowSeconds + MAX_CLOCK_SKEW_SECONDS
    && claims.expiresAt >= nowSeconds - MAX_CLOCK_SKEW_SECONDS
    && claims.expiresAt > claims.issuedAt
    && claims.expiresAt - claims.issuedAt
      <= MAX_AGENT_INVOCATION_CONTEXT_TTL_SECONDS
    && (!allowedModes || allowedModes.includes(claims.mode))
  )
}

interface RequestProofHeaders {
  timestamp: string
  nonce: string
  bodySha256: string
  signature: string
}

function getRequestProofHeaders(
  request: NextRequest
): RequestProofHeaders | null {
  const version = request.headers.get(AGENT_REQUEST_PROOF_VERSION_HEADER)
  const timestamp = request.headers.get(AGENT_REQUEST_PROOF_TIMESTAMP_HEADER)
  const nonce = request.headers.get(AGENT_REQUEST_PROOF_NONCE_HEADER)
  const bodySha256 = request.headers.get(
    AGENT_REQUEST_PROOF_BODY_SHA256_HEADER
  )
  const signature = request.headers.get(AGENT_REQUEST_PROOF_SIGNATURE_HEADER)
  if (version !== REQUEST_PROOF_VERSION) return null
  if (!timestamp || !nonce || !bodySha256 || !signature) return null
  if (!UUID_RE.test(nonce) || !SHA256_HEX_RE.test(bodySha256)) return null
  return { timestamp, nonce, bodySha256, signature }
}

function isCurrentProofTimestamp(
  timestampValue: string,
  nowSeconds: number,
  claims: AgentInvocationContext
): boolean {
  const timestamp = Number(timestampValue)
  return (
    Number.isInteger(timestamp)
    && Math.abs(timestamp - nowSeconds) <= MAX_CLOCK_SKEW_SECONDS
    && timestamp >= claims.issuedAt - MAX_CLOCK_SKEW_SECONDS
    && timestamp <= claims.expiresAt + MAX_CLOCK_SKEW_SECONDS
  )
}

function hasValidProofSignature(options: {
  proof: RequestProofHeaders
  secret: string
  invocationNonce: string
  method: string
  route: string
}): boolean {
  const { proof, secret, invocationNonce, method, route } = options
  const expectedProof = createHmac(
    "sha256",
    deriveRequestProofKey(secret, invocationNonce)
  )
    .update(
      canonicalRequestProof({
        timestamp: proof.timestamp,
        nonce: proof.nonce,
        method,
        route,
        bodySha256: proof.bodySha256,
      })
    )
    .digest()
  let providedProof: Buffer
  try {
    providedProof = Buffer.from(proof.signature, "base64url")
  } catch {
    return false
  }
  if (providedProof.length !== expectedProof.length) {
    timingSafeEqual(expectedProof, expectedProof)
    return false
  }
  return timingSafeEqual(providedProof, expectedProof)
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

async function hasMatchingBodyHash(
  request: NextRequest,
  expectedBodySha256: string
): Promise<boolean> {
  const actualBodySha256 = await hashBoundedRequestBody(request)
  return actualBodySha256 === expectedBodySha256
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

  const secret = await getInvocationSigningSecret()
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return null

  const claims = decodeInvocationToken(token, secret)
  if (!claims) return null
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!isCurrentInvocation(claims, nowSeconds, options.allowedModes)) return null

  const proof = getRequestProofHeaders(request)
  if (!proof) return null
  if (!isCurrentProofTimestamp(proof.timestamp, nowSeconds, claims)) return null

  const method = request.method.toUpperCase()
  const route = request.nextUrl.pathname
  if (!await hasMatchingBodyHash(request, proof.bodySha256)) return null
  if (!hasValidProofSignature({
    proof,
    secret,
    invocationNonce: claims.nonce,
    method,
    route,
  })) return null

  const consumed = await (options.consumeNonce ?? consumeRequestNonce)({
    nonce: proof.nonce,
    invocationNonce: claims.nonce,
    ownerEmail: claims.ownerEmail,
    method,
    route,
    expiresAt: claims.expiresAt + MAX_CLOCK_SKEW_SECONDS,
  })
  if (!consumed) return null

  return claims
}
