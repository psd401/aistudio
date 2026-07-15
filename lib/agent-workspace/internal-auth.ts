/**
 * Shared internal-API authentication for agent → Next.js endpoints (#912, #1232,
 * #1233).
 *
 * The agent runtime authenticates to /api/agent/* endpoints with a pre-shared
 * secret (Bearer) from psd-agent/{env}/internal-api-key. This module centralizes
 * the secret resolution + constant-time comparison so consent-link, the DWD
 * workspace-token broker, and the account-request provisioning endpoint all use
 * exactly the same auth (previously inline in consent-link/route.ts).
 */

import { NextRequest } from "next/server"
import { createLogger } from "@/lib/logger"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { timingSafeEqual } from "node:crypto"

const log = createLogger({ module: "agent-internal-auth" })

/**
 * Resolve the shared secret. Prefers AGENT_INTERNAL_API_KEY env var (local dev)
 * and falls back to Secrets Manager at AGENT_INTERNAL_API_KEY_SECRET_ID (ECS).
 * The SM read is cached for 5 minutes. Returns null if not configured — callers
 * treat that as unauthorized so the endpoint fails closed.
 */
export async function getExpectedInternalSecret(): Promise<string | null> {
  const envVal = process.env.AGENT_INTERNAL_API_KEY
  if (envVal) return envVal

  // Env var name is `_SECRET_ID` (not `_ARN`) — Secrets Manager accepts a bare
  // secret name *or* a full ARN; we use the name.
  const id = process.env.AGENT_INTERNAL_API_KEY_SECRET_ID
  if (!id) return null

  return getSecretString(id)
}

/**
 * Validate the shared secret from the Authorization header with a constant-time
 * comparison. Returns false (fail-closed) on a missing/malformed header or an
 * unconfigured secret.
 */
export async function validateInternalSecret(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return false
  }

  const token = authHeader.slice(7)
  const expectedSecret = await getExpectedInternalSecret()
  if (!expectedSecret) {
    log.error("agent internal secret is not configured — rejecting request")
    return false
  }

  // Constant-time comparison. On a length mismatch we still run timingSafeEqual
  // against the expected buffer so the code path has stable wall-clock regardless
  // of outcome (a length mismatch itself leaks nothing an attacker couldn't
  // derive from the deploy manifest — the secret has fixed length per env).
  const tokenBuf = Buffer.from(token)
  const expectedBuf = Buffer.from(expectedSecret)
  if (tokenBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(tokenBuf, expectedBuf)
}
