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
import { isCredentialName } from "@/lib/agent-credentials/name-grammar"

const log = createLogger({ module: "consent-token" })

/**
 * Which credential slot the consent flow is capturing.
 *
 *   'agent_account' — Google OAuth for agnt_<uniqname>@psd401.net (broad scopes)
 *   'user_account'  — Google OAuth for the user themselves (narrow scopes)
 *   'cognito_data'  — Cognito refresh token for the data-MCP integration.
 *                     Captured by the /agent-connect-data page, stored at
 *                     psd-agent-creds/{env}/user/{email}/cognito-refresh.
 *   'plaud'         — Plaud OAuth refresh token (public client, PKCE).
 *   'canva'         — Canva Connect OAuth refresh token (confidential client,
 *                     PKCE). Captured by /agent-connect-canva, stored at
 *                     psd-agent-creds/{env}/user/{email}/canva.
 *   'credential_entry'
 *                   — A user-supplied secret (API key, vendor token) typed
 *                     into /agent-connect-credential and written through the
 *                     credential broker's owner-scoped put path. Replaces
 *                     asking the user to paste the value into chat (#1887).
 *                     Carries the target credential name in `cred` and expires
 *                     in 15 minutes rather than 24 hours.
 */
export type ConsentTokenKind =
  | "agent_account"
  | "user_account"
  | "cognito_data"
  | "plaud"
  | "canva"
  | "aistudio"
  | "credential_entry"

export interface ConsentTokenPayload {
  /** Human user email (e.g. hagelk@psd401.net) */
  sub: string
  /** Agent account email (e.g. agnt_hagelk@psd401.net) */
  agent: string
  /** Fixed purpose discriminator */
  purpose: "workspace-consent"
  /** One-time nonce (stored in psd_agent_workspace_consent_nonces) */
  nonce: string
  /**
   * Which OAuth identity is being consented (#912 Phase 1):
   *   'agent_account' — user signs in as agnt_<uniqname> (broad scopes)
   *   'user_account'  — user signs in as themselves (narrow scopes for
   *                     reading their own Gmail/Tasks/Drive)
   * Optional for backwards compatibility with tokens issued before Phase 1.
   * When absent, treated as 'agent_account'.
   */
  kind?: ConsentTokenKind
  /**
   * Target credential name for `kind: 'credential_entry'` (#1887). Matches the
   * broker's own name grammar so the page can hand it straight to
   * `AgentCredentialBroker.put`. Absent for every other kind.
   *
   * This is a slot NAME (e.g. `freshservice_api_key`), never a secret value —
   * the secret is typed into the page and POSTed, and never appears in a URL.
   */
  cred?: string
}

const DEFAULT_TOKEN_EXPIRY = "24h"
/**
 * A credential-entry link is a live secret-entry form bound to one person, so
 * it gets a much tighter window than an OAuth consent link. 15 minutes is long
 * enough to open a vendor profile page, copy a key, and paste it into the form.
 */
const CREDENTIAL_ENTRY_TOKEN_EXPIRY = "15m"

/**
 * How long a token of this kind stays valid. Exported so callers (and tests)
 * can assert the window without re-deriving it.
 */
export function consentTokenExpiry(kind: ConsentTokenKind | undefined): string {
  return kind === "credential_entry"
    ? CREDENTIAL_ENTRY_TOKEN_EXPIRY
    : DEFAULT_TOKEN_EXPIRY
}

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
 * Sign a consent token JWT. Expiry is 24 hours for the OAuth kinds and 15
 * minutes for `credential_entry` (see `consentTokenExpiry`).
 *
 * Throws when a `credential_entry` payload carries no usable credential name:
 * the entry page cannot decide where to store the secret without it, and a
 * link that fails at submit time has already cost the user their key.
 */
export async function signConsentToken(payload: ConsentTokenPayload): Promise<string> {
  const { SignJWT } = await import("jose")

  if (payload.kind === "credential_entry" && !isCredentialName(payload.cred)) {
    throw new Error(
      "credential_entry consent tokens require a valid `cred` credential name"
    )
  }

  const jwt = await new SignJWT({ ...payload } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(consentTokenExpiry(payload.kind))
    .sign(getSigningSecret())

  log.info(
    "Consent token signed",
    sanitizeForLogging({
      sub: payload.sub,
      nonce: payload.nonce,
      tokenLen: jwt.length,
      // Last 8 chars of the signature segment. The signature is a public hash
      // artifact (not a secret); logging the tail lets us correlate a sign
      // event with a later verify failure to see exactly which characters
      // were lost in transit through Google Chat.
      sigTail: jwt.split(".").pop()?.slice(-8) ?? "",
    })
  )
  return jwt
}

const CONSENT_TOKEN_KINDS = new Set<string>([
  "agent_account",
  "user_account",
  "cognito_data",
  "plaud",
  "canva",
  "aistudio",
  "credential_entry",
])

function isConsentTokenKind(value: unknown): value is ConsentTokenKind {
  return typeof value === "string" && CONSENT_TOKEN_KINDS.has(value)
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
    const kind = raw.kind
    const cred = raw.cred

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

    // Validate kind if present. Absent = legacy token, treat as agent_account.
    let resolvedKind: ConsentTokenKind | undefined
    if (isConsentTokenKind(kind)) {
      resolvedKind = kind
    } else if (kind !== undefined) {
      log.warn("Consent token has unknown kind", { kind })
      return null
    }

    // A credential_entry token without a usable slot name is unusable: the
    // page would have nowhere to put the secret. Fail closed here rather than
    // after the user has already typed their key into the form.
    let resolvedCred: string | undefined
    if (resolvedKind === "credential_entry") {
      if (!isCredentialName(cred)) {
        log.warn("Credential-entry consent token has no valid credential name")
        return null
      }
      resolvedCred = cred
    }

    return {
      sub,
      agent,
      purpose: "workspace-consent",
      nonce,
      kind: resolvedKind,
      ...(resolvedCred ? { cred: resolvedCred } : {}),
    }
  } catch (error) {
    logVerifyFailure(token, error)
    return null
  }
}

/**
 * Log the token's shape (never its content) so we can diagnose mangling
 * in transit. tokenLen + segments + sigTail uniquely identify a token
 * class without exposing the payload.
 */
function logVerifyFailure(token: string, error: unknown): void {
  const segments = token?.split(".") ?? []
  log.warn("Consent token verification failed", {
    error: error instanceof Error ? error.message : String(error),
    tokenLen: token?.length ?? 0,
    segments: segments.length,
    sigTail: segments[segments.length - 1]?.slice(-8) ?? "",
  })
}
