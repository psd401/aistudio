/**
 * Consent-callback identity verification (#1234).
 *
 * The Google OAuth consent callback must confirm WHICH account authorized the
 * grant, not just that *some* @psd401.net account did. The OAuth client is
 * "Internal", so Google only guarantees a domain member signed in — the
 * account chooser still lets the user pick the wrong account (a `login_hint`
 * / `hd` param is a hint, never enforcement). Without this check a human can
 * complete an agent-slot link signed in as themselves, storing their personal
 * refresh token in the agent's credential slot (silent attribution
 * corruption, confirmed in production).
 *
 * The code-exchange response already carries an `id_token` (the flow requests
 * `openid email`). This module verifies that token's signature/audience/issuer
 * and matches its `email` claim (requiring `email_verified`) against the
 * account the consent link was minted for.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"

/** Machine-readable failure reason (for logging/branching); never shown raw to users. */
export type IdentityFailureReason = "missing" | "invalid" | "unverified" | "mismatch"

export interface IdentityVerificationResult {
  ok: boolean
  /** The verified, lower-cased email from the id_token (present when ok, or on a mismatch). */
  email?: string
  /** Failure discriminator; absent when ok. */
  reason?: IdentityFailureReason
}

interface IdTokenClaims {
  email?: string
  email_verified?: boolean
}

/**
 * Verify the id_token returned by a Google OAuth code exchange and confirm it
 * was granted by `expectedEmail`.
 *
 * Checks, in order:
 *   1. id_token is present.
 *   2. signature / audience (= our OAuth client id) / issuer / expiry are valid.
 *   3. `email_verified` is true.
 *   4. the `email` claim equals `expectedEmail` (case-insensitive).
 *
 * Returns `{ ok: true, email }` on success, or `{ ok: false, reason }` (with
 * `email` populated on a mismatch so the caller can log expected-vs-granted).
 * Never throws — a verification error becomes `{ ok: false, reason: "invalid" }`.
 */
export async function verifyGrantedIdentity(
  idToken: string | undefined,
  clientId: string,
  expectedEmail: string,
  log: ReturnType<typeof createLogger>
): Promise<IdentityVerificationResult> {
  if (!idToken) {
    log.error(
      "OAuth code exchange returned no id_token — cannot verify the granting account",
      sanitizeForLogging({ expectedEmail })
    )
    return { ok: false, reason: "missing" }
  }

  // Dynamic import keeps the Node-only google-auth-library out of any edge
  // bundle (mirrors the jose import in consent-token.ts).
  const { OAuth2Client } = await import("google-auth-library")
  const client = new OAuth2Client(clientId)

  let claims: IdTokenClaims | undefined
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId })
    claims = ticket.getPayload() as IdTokenClaims | undefined
  } catch (err) {
    log.error(
      "id_token verification failed (bad signature/audience/issuer/expiry)",
      sanitizeForLogging({ expectedEmail, error: err instanceof Error ? err.message : String(err) })
    )
    return { ok: false, reason: "invalid" }
  }

  if (!claims?.email) {
    log.error("id_token has no email claim", sanitizeForLogging({ expectedEmail }))
    return { ok: false, reason: "invalid" }
  }

  if (claims.email_verified !== true) {
    log.error(
      "id_token email is not verified",
      sanitizeForLogging({ expectedEmail, grantedEmail: claims.email })
    )
    return { ok: false, reason: "unverified" }
  }

  const granted = claims.email.toLowerCase()
  const expected = expectedEmail.toLowerCase()
  if (granted !== expected) {
    log.error(
      "Consent granted by the wrong Google account",
      sanitizeForLogging({ expectedEmail: expected, grantedEmail: granted })
    )
    return { ok: false, reason: "mismatch", email: granted }
  }

  return { ok: true, email: granted }
}
