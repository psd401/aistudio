"use server"

/**
 * Canva OAuth consent actions (chat → browser → server-captured refresh token).
 *
 * Mirrors the Plaud agent-connect flow (agent-plaud.actions.ts) but for Canva's
 * Connect REST API (https://www.canva.dev/docs/connect/): authorization_code +
 * refresh_token grants, PKCE (S256), CONFIDENTIAL client (client_id +
 * client_secret from the Canva Developer Portal, stored in the shared secret
 * psd-agent/{env}/canva-oauth-client). The one-time browser consent lets the
 * agent act on the user's OWN Canva account; the refresh token is stored
 * per-user at psd-agent-creds/{env}/user/{email}/canva and used headlessly by
 * the psd-canva skill.
 *
 * Reuses the shared consent-nonce table (rate limit + one-time-use replay
 * protection). The PKCE code_verifier is stored on the nonce row at mint time
 * and read back here; only the S256 challenge ever appears in a URL.
 *
 * Unlike Plaud (public client, Dynamic Client Registration), Canva is a
 * confidential client: there is NO DCR — the client credentials are populated
 * out of band (agent-executed, per issue #1176 Setup steps) and read here. The
 * client_secret is used ONLY in the HTTP Basic auth header of the token
 * exchange and is never placed in a URL or logged.
 */

import { createHash } from "node:crypto"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { and, eq, isNull, sql } from "drizzle-orm"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import { getSecretJson, storeCanvaRefreshToken } from "@/lib/agent-workspace/secrets-manager"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"

const CANVA_AUTHORIZE_URL = process.env.CANVA_AUTHORIZE_URL ?? "https://www.canva.com/api/oauth/authorize"
const CANVA_TOKEN_URL = process.env.CANVA_TOKEN_URL ?? "https://api.canva.com/rest/v1/oauth/token"
const CANVA_OAUTH_SECRET_ID =
  process.env.CANVA_OAUTH_SECRET_ID ?? `psd-agent/${process.env.ENVIRONMENT ?? "dev"}/canva-oauth-client`

/**
 * v1 scope set (space-separated per Canva's authorize endpoint). Deliberately
 * excludes autofill/brand-template scopes — those APIs are Enterprise-gated and
 * the district is on Canva for Education (issue #1176 Decision 2).
 */
const CANVA_SCOPES =
  "design:content:read design:meta:read design:content:write asset:read asset:write folder:read profile:read"

function canvaRedirectUri(): string {
  return `${getIssuerUrl()}/agent-connect-canva/callback`
}

/**
 * Read the confidential OAuth client credentials from Secrets Manager. Returns
 * null when the secret is absent, unparseable, or still holding a placeholder —
 * the caller surfaces a "not configured" message so the flow fails closed
 * rather than emitting a malformed authorize URL. Never logs the secret.
 */
async function getCanvaClientCreds(
  log: ReturnType<typeof createLogger>
): Promise<{ client_id: string; client_secret: string } | null> {
  try {
    const creds = await getSecretJson<{ client_id?: string; client_secret?: string }>(
      CANVA_OAUTH_SECRET_ID
    )
    const clientId = creds?.client_id
    const clientSecret = creds?.client_secret
    if (
      typeof clientId === "string" &&
      clientId &&
      !clientId.startsWith("PLACEHOLDER") &&
      typeof clientSecret === "string" &&
      clientSecret &&
      !clientSecret.startsWith("PLACEHOLDER")
    ) {
      return { client_id: clientId, client_secret: clientSecret }
    }
    log.error("Canva OAuth client credentials are not populated yet", {})
    return null
  } catch (err) {
    log.error("Failed to read Canva OAuth client secret", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** HTTP Basic auth header for the confidential token endpoint. */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export interface CanvaConsentVerifyResult {
  valid: boolean
  ownerEmail?: string
  canvaOAuthUrl?: string
  error?: string
}

/**
 * Verify the consent JWT, look up the PKCE verifier stored on the nonce row,
 * and return the Canva authorize URL (called by the /agent-connect-canva
 * landing page before the user clicks "Connect"). The client_secret is NOT
 * needed here — only the public client_id appears in the authorize URL.
 */
export async function verifyCanvaConsentAndGetOAuthUrl(
  token: string
): Promise<ActionState<CanvaConsentVerifyResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("verifyCanvaConsent")
  const log = createLogger({ requestId, action: "verifyCanvaConsent" })

  try {
    const payload = await verifyConsentToken(token)
    if (!payload || payload.kind !== "canva") {
      timer({ status: "error" })
      return createSuccess({ valid: false, error: "This consent link is invalid or for a different flow." })
    }

    const creds = await getCanvaClientCreds(log)
    if (!creds) {
      timer({ status: "error" })
      return createSuccess({ valid: false, error: "Canva integration is not configured yet. Contact an administrator." })
    }

    // Read the PKCE verifier from the nonce row (must still be unconsumed and fresh).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [row] = await executeQuery(
      (db) =>
        db
          .select({ codeVerifier: psdAgentWorkspaceConsentNonces.codeVerifier })
          .from(psdAgentWorkspaceConsentNonces)
          .where(
            sql`${psdAgentWorkspaceConsentNonces.nonce} = ${payload.nonce}
                AND ${psdAgentWorkspaceConsentNonces.tokenKind} = 'canva'
                AND ${psdAgentWorkspaceConsentNonces.consumedAt} IS NULL
                AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
          )
          .limit(1),
      "lookupCanvaNonce"
    )
    if (!row || !row.codeVerifier) {
      timer({ status: "error" })
      return createSuccess({ valid: false, error: "This consent link has expired or was already used. Ask your agent for a new one." })
    }

    const params = new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: canvaRedirectUri(),
      response_type: "code",
      scope: CANVA_SCOPES,
      state: payload.nonce,
      code_challenge: s256Challenge(row.codeVerifier),
      code_challenge_method: "S256",
    })

    timer({ status: "success" })
    log.info("Canva consent verified, authorize URL generated", sanitizeForLogging({ ownerEmail: payload.sub }))
    return createSuccess({
      valid: true,
      ownerEmail: payload.sub,
      canvaOAuthUrl: `${CANVA_AUTHORIZE_URL}?${params.toString()}`,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to verify Canva consent link", {
      context: "verifyCanvaConsent",
      requestId,
      operation: "verifyCanvaConsent",
    })
  }
}

export interface CanvaCallbackResult {
  success: boolean
  ownerEmail?: string
  error?: string
}

/**
 * Exchange the Canva authorization code (with the stored PKCE verifier) for a
 * refresh token and persist it per-user. Consumes the nonce only on success so
 * a transient failure is retryable. Confidential client — the token endpoint is
 * called with HTTP Basic auth (client_id:client_secret); the code_verifier is
 * also sent (Canva requires PKCE even for confidential clients).
 */
export async function handleCanvaCallback(
  code: string,
  state: string
): Promise<ActionState<CanvaCallbackResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("handleCanvaCallback")
  const log = createLogger({ requestId, action: "handleCanvaCallback" })

  try {
    if (!/^[\da-f]{64}$/.test(state)) {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "Invalid consent state. Ask your agent for a new consent link." })
    }
    if (!code || typeof code !== "string") {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "Missing authorization code." })
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [row] = await executeQuery(
      (db) =>
        db
          .select({
            ownerEmail: psdAgentWorkspaceConsentNonces.ownerEmail,
            tokenKind: psdAgentWorkspaceConsentNonces.tokenKind,
            codeVerifier: psdAgentWorkspaceConsentNonces.codeVerifier,
          })
          .from(psdAgentWorkspaceConsentNonces)
          .where(
            sql`${psdAgentWorkspaceConsentNonces.nonce} = ${state}
                AND ${psdAgentWorkspaceConsentNonces.consumedAt} IS NULL
                AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
          )
          .limit(1),
      "lookupCanvaCallbackNonce"
    )
    if (!row || row.tokenKind !== "canva" || !row.codeVerifier) {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "This consent link has already been used or has expired. Ask your agent for a new one." })
    }

    const creds = await getCanvaClientCreds(log)
    if (!creds) {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "Canva integration is not configured yet." })
    }

    // Exchange the code (confidential client → Basic auth + PKCE verifier).
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: canvaRedirectUri(),
      code_verifier: row.codeVerifier,
    })
    const resp = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: basicAuthHeader(creds.client_id, creds.client_secret),
      },
      body: body.toString(),
      // Bound the exchange so an unresponsive Canva can't hang the server action.
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await resp.json().catch(() => ({}))) as {
      refresh_token?: string
      scope?: string
      error?: string
      error_description?: string
    }
    if (!resp.ok || !data.refresh_token) {
      log.warn("Canva token exchange failed", { status: resp.status, error: data.error })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Canva rejected the authorization. Please try the link again.",
      })
    }

    // Store the per-user refresh token (single-use, rotates on each refresh).
    await storeCanvaRefreshToken(row.ownerEmail, {
      refresh_token: data.refresh_token,
      scope: data.scope,
      obtained_at: new Date().toISOString(),
    })

    // Consume the nonce (atomic, only-if-unconsumed).
    await executeQuery(
      (db) =>
        db
          .update(psdAgentWorkspaceConsentNonces)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(psdAgentWorkspaceConsentNonces.nonce, state),
              isNull(psdAgentWorkspaceConsentNonces.consumedAt)
            )
          ),
      "consumeCanvaNonce"
    )

    timer({ status: "success" })
    log.info("Canva account connected", sanitizeForLogging({ ownerEmail: row.ownerEmail }))
    return createSuccess({ success: true, ownerEmail: row.ownerEmail })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to complete Canva connection", {
      context: "handleCanvaCallback",
      requestId,
      operation: "handleCanvaCallback",
    })
  }
}
