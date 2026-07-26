import { NextRequest } from "next/server"
import { createHmac, timingSafeEqual } from "node:crypto"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"

export const AGENT_INVOCATION_CONTEXT_HEADER = "x-agent-invocation-context"
export const AGENT_INVOCATION_CONTEXT_AUDIENCE = "psd-agent-internal"
const MAX_TOKEN_TTL_SECONDS = 15 * 60
const MAX_CLOCK_SKEW_SECONDS = 30

export type AgentInvocationMode = "owner" | "consultation" | "scheduled"

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
  return value === "owner" || value === "consultation" || value === "scheduled"
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

  return claims
}
