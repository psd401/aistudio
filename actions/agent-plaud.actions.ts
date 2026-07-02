"use server"

/**
 * Plaud OAuth consent actions (chat → browser → server-captured refresh token).
 *
 * Mirrors the Google Workspace agent-connect flow (agent-workspace.actions.ts)
 * but for Plaud's OAuth 2.1 server (https://mcp.plaud.ai): authorization_code +
 * refresh_token, PKCE (S256), public client via Dynamic Client Registration.
 * The one-time browser consent lets the agent read the user's OWN Plaud
 * recordings; the refresh token is stored per-user at
 * psd-agent-creds/{env}/user/{email}/plaud and used headlessly by psd-plaud.
 *
 * Reuses the shared consent-nonce table (rate limit + one-time-use replay
 * protection). The PKCE code_verifier is stored on the nonce row at mint time
 * and read back here; only the S256 challenge ever appears in a URL.
 */

import { createHash } from "node:crypto"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { and, eq, isNull, sql } from "drizzle-orm"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import { getSecretJson, storePlaudRefreshToken } from "@/lib/agent-workspace/secrets-manager"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"

const PLAUD_AUTHORIZE_URL = process.env.PLAUD_AUTHORIZE_URL ?? "https://mcp.plaud.ai/authorize"
const PLAUD_TOKEN_URL = process.env.PLAUD_TOKEN_URL ?? "https://mcp.plaud.ai/token"
const PLAUD_OAUTH_SECRET_ID =
  process.env.PLAUD_OAUTH_SECRET_ID ?? `psd-agent/${process.env.ENVIRONMENT ?? "dev"}/plaud-oauth-client`

function plaudRedirectUri(): string {
  return `${getIssuerUrl()}/agent-connect-plaud/callback`
}

async function getPlaudClientId(): Promise<string | null> {
  try {
    const creds = await getSecretJson(PLAUD_OAUTH_SECRET_ID)
    const clientId = creds?.client_id
    return typeof clientId === "string" && clientId && clientId !== "PLACEHOLDER" ? clientId : null
  } catch {
    return null
  }
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export interface PlaudConsentVerifyResult {
  valid: boolean
  ownerEmail?: string
  plaudOAuthUrl?: string
  error?: string
}

/**
 * Verify the consent JWT, look up the PKCE verifier stored on the nonce row,
 * and return the Plaud authorize URL (called by the /agent-connect-plaud
 * landing page before the user clicks "Connect").
 */
export async function verifyPlaudConsentAndGetOAuthUrl(
  token: string
): Promise<ActionState<PlaudConsentVerifyResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("verifyPlaudConsent")
  const log = createLogger({ requestId, action: "verifyPlaudConsent" })

  try {
    const payload = await verifyConsentToken(token)
    if (!payload || payload.kind !== "plaud") {
      timer({ status: "error" })
      return createSuccess({ valid: false, error: "This consent link is invalid or for a different flow." })
    }

    const clientId = await getPlaudClientId()
    if (!clientId) {
      timer({ status: "error" })
      log.error("Plaud OAuth client_id not configured")
      return createSuccess({ valid: false, error: "Plaud integration is not configured yet. Contact an administrator." })
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
                AND ${psdAgentWorkspaceConsentNonces.consumedAt} IS NULL
                AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
          )
          .limit(1),
      "lookupPlaudNonce"
    )
    if (!row || !row.codeVerifier) {
      timer({ status: "error" })
      return createSuccess({ valid: false, error: "This consent link has expired or was already used. Ask your agent for a new one." })
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: plaudRedirectUri(),
      response_type: "code",
      state: payload.nonce,
      code_challenge: s256Challenge(row.codeVerifier),
      code_challenge_method: "S256",
    })

    timer({ status: "success" })
    log.info("Plaud consent verified, authorize URL generated", sanitizeForLogging({ ownerEmail: payload.sub }))
    return createSuccess({
      valid: true,
      ownerEmail: payload.sub,
      plaudOAuthUrl: `${PLAUD_AUTHORIZE_URL}?${params.toString()}`,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to verify Plaud consent link", {
      context: "verifyPlaudConsent",
      requestId,
      operation: "verifyPlaudConsent",
    })
  }
}

export interface PlaudCallbackResult {
  success: boolean
  ownerEmail?: string
  error?: string
}

/**
 * Exchange the Plaud authorization code (with the stored PKCE verifier) for a
 * refresh token and persist it per-user. Consumes the nonce only on success so
 * a transient failure is retryable.
 */
export async function handlePlaudCallback(
  code: string,
  state: string
): Promise<ActionState<PlaudCallbackResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("handlePlaudCallback")
  const log = createLogger({ requestId, action: "handlePlaudCallback" })

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
      "lookupPlaudCallbackNonce"
    )
    if (!row || row.tokenKind !== "plaud" || !row.codeVerifier) {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "This consent link has already been used or has expired. Ask your agent for a new one." })
    }

    const clientId = await getPlaudClientId()
    if (!clientId) {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "Plaud integration is not configured yet." })
    }

    // Exchange the code (public client + PKCE).
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: plaudRedirectUri(),
      client_id: clientId,
      code_verifier: row.codeVerifier,
    })
    const resp = await fetch(PLAUD_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    })
    const data = (await resp.json().catch(() => ({}))) as {
      refresh_token?: string
      scope?: string
      error?: string
      error_description?: string
    }
    if (!resp.ok || !data.refresh_token) {
      log.warn("Plaud token exchange failed", { status: resp.status, error: data.error })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Plaud rejected the authorization. Please try the link again.",
      })
    }

    // Store the per-user refresh token.
    await storePlaudRefreshToken(row.ownerEmail, {
      refresh_token: data.refresh_token,
      client_id: clientId,
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
      "consumePlaudNonce"
    )

    timer({ status: "success" })
    log.info("Plaud account connected", sanitizeForLogging({ ownerEmail: row.ownerEmail }))
    return createSuccess({ success: true, ownerEmail: row.ownerEmail })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to complete Plaud connection", {
      context: "handlePlaudCallback",
      requestId,
      operation: "handlePlaudCallback",
    })
  }
}
