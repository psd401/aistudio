/**
 * Consent Token Signing & Verification
 *
 * Signs and verifies short-lived JWTs used for the one-time Google Workspace
 * OAuth consent flow. Tokens carry the owner email, agent email, purpose, and
 * a nonce (which the callback route marks as consumed to prevent replay).
 *
 * Signing key: HMAC-SHA256 derived from NEXTAUTH_SECRET. This keeps the
 * consent token infrastructure zero-config — no additional secrets to manage.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "consent-token" })

export interface ConsentTokenPayload {
  /** Human user email (e.g. hagelk@psd401.net) */
  sub: string
  /** Agent account email (e.g. agnt_hagelk@psd401.net) */
  agent: string
  /** Fixed purpose discriminator */
  purpose: "workspace-consent"
  /** One-time nonce (stored in psd_agent_workspace_consent_nonces) */
  nonce: string
}

const TOKEN_EXPIRY = "24h"

/**
 * Derive the HMAC secret from AUTH_SECRET or NEXTAUTH_SECRET. Throws if
 * neither env var is set (which would also break NextAuth/Auth.js, so this is
 * a hard requirement). AUTH_SECRET is the NextAuth v5 canonical name and takes
 * precedence; NEXTAUTH_SECRET is the legacy v4 fallback.
 */
function getSigningSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is not set — cannot sign consent tokens")
  }
  return new TextEncoder().encode(secret)
}

/**
 * Sign a consent token JWT with 24-hour expiry.
 */
export async function signConsentToken(payload: ConsentTokenPayload): Promise<string> {
  const { SignJWT } = await import("jose")

  const jwt = await new SignJWT({ ...payload } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getSigningSecret())

  log.info("Consent token signed", sanitizeForLogging({ sub: payload.sub, nonce: payload.nonce }))
  return jwt
}

/**
 * Verify a consent token JWT. Returns the payload on success, null on any
 * verification failure (expired, tampered, wrong purpose, etc.).
 */
export async function verifyConsentToken(token: string): Promise<ConsentTokenPayload | null> {
  const { jwtVerify } = await import("jose")

  try {
    const { payload } = await jwtVerify(token, getSigningSecret())

    // Validate required fields with proper type guards
    const raw = payload as Record<string, unknown>
    const sub = raw.sub
    const agent = raw.agent
    const purpose = raw.purpose
    const nonce = raw.nonce

    if (
      typeof sub !== "string" ||
      typeof agent !== "string" ||
      typeof nonce !== "string" ||
      purpose !== "workspace-consent"
    ) {
      log.warn("Consent token missing required fields", {
        hasSub: typeof sub === "string",
        hasAgent: typeof agent === "string",
        purpose,
        hasNonce: typeof nonce === "string",
      })
      return null
    }

    return { sub, agent, purpose: "workspace-consent", nonce }
  } catch (error) {
    log.warn("Consent token verification failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
