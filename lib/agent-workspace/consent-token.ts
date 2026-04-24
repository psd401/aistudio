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

import { createLogger } from "@/lib/logger"

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
 * Derive the HMAC secret from NEXTAUTH_SECRET. Throws if the env var is
 * missing (which would also break NextAuth, so this is a hard requirement).
 */
function getSigningSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not set — cannot sign consent tokens")
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

  log.info("Consent token signed", { sub: payload.sub, nonce: payload.nonce })
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

    // Validate required fields
    const sub = payload.sub as string | undefined
    const agent = (payload as Record<string, unknown>).agent as string | undefined
    const purpose = (payload as Record<string, unknown>).purpose as string | undefined
    const nonce = (payload as Record<string, unknown>).nonce as string | undefined

    if (!sub || !agent || purpose !== "workspace-consent" || !nonce) {
      log.warn("Consent token missing required fields", {
        hasSub: !!sub,
        hasAgent: !!agent,
        purpose,
        hasNonce: !!nonce,
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
