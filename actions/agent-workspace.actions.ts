"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, and, isNull, sql } from "drizzle-orm"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { users } from "@/lib/db/schema/tables/users"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import { storeRefreshToken, getSecretJson } from "@/lib/agent-workspace/secrets-manager"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"

/**
 * Google OAuth scopes requested at bootstrap. All scopes are requested
 * at once (progressive consent is deferred to a future issue).
 */
const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces",
  "openid",
  "email",
  "profile",
]

interface GoogleOAuthClientCreds {
  client_id: string
  client_secret: string
}

/**
 * Load Google OAuth client credentials. Prefers env vars (local dev) and
 * falls back to Secrets Manager at GOOGLE_WORKSPACE_OAUTH_SECRET_ID in
 * ECS. The SM read is cached for 5 minutes in secrets-manager.ts.
 *
 * Returns null if neither source has valid credentials — callers surface
 * a "not configured" error to the operator, which is the correct behavior
 * before IT has set up the GCP OAuth client.
 */
async function getOAuthClientCredentials(): Promise<GoogleOAuthClientCreds | null> {
  const envId = process.env.GOOGLE_WORKSPACE_CLIENT_ID
  const envSecret = process.env.GOOGLE_WORKSPACE_CLIENT_SECRET
  if (envId && envSecret) {
    return { client_id: envId, client_secret: envSecret }
  }

  // Env var is `_SECRET_ID` (Secrets Manager accepts a bare name); the
  // legacy `_ARN` name was misleading because we stored a name not an ARN.
  const id = process.env.GOOGLE_WORKSPACE_OAUTH_SECRET_ID
  if (!id) return null

  const json = await getSecretJson<Partial<GoogleOAuthClientCreds>>(id)
  if (!json?.client_id || !json?.client_secret) return null
  if (
    json.client_id.startsWith("PLACEHOLDER") ||
    json.client_secret.startsWith("PLACEHOLDER")
  ) {
    return null
  }
  return { client_id: json.client_id, client_secret: json.client_secret }
}

export interface VerifyConsentResult {
  valid: boolean
  ownerEmail?: string
  agentEmail?: string
  googleOAuthUrl?: string
  error?: string
}

/**
 * Verify a consent token and return the Google OAuth URL for the user to
 * begin the authorization flow.
 *
 * This is a public action (no auth required) — the signed token IS the auth.
 */
export async function verifyConsentAndGetOAuthUrl(
  token: string
): Promise<ActionState<VerifyConsentResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("verifyConsentAndGetOAuthUrl")
  const log = createLogger({ requestId, action: "verifyConsentAndGetOAuthUrl" })

  try {
    const payload = await verifyConsentToken(token)
    if (!payload) {
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error: "Invalid or expired consent link. Ask your agent for a new one.",
      })
    }

    // This unconsumed check is a UX guard, not a security gate. Actual replay
    // prevention happens in handleOAuthCallback where the nonce is atomically
    // consumed via UPDATE … WHERE consumed_at IS NULL. Between this read and
    // that atomic write, concurrent tabs could both see the nonce as valid and
    // redirect to Google — but only one callback will successfully consume it.
    const [nonceRow] = await executeQuery(
      (db) =>
        db
          .select()
          .from(psdAgentWorkspaceConsentNonces)
          .where(
            and(
              eq(psdAgentWorkspaceConsentNonces.nonce, payload.nonce),
              isNull(psdAgentWorkspaceConsentNonces.consumedAt)
            )
          )
          .limit(1),
      "checkConsentNonce"
    )

    if (!nonceRow) {
      timer({ status: "error" })
      log.warn("Consent nonce already consumed or not found", { nonce: payload.nonce })
      return createSuccess({
        valid: false,
        error: "This consent link has already been used. Ask your agent for a new one.",
      })
    }

    const oauthClient = await getOAuthClientCredentials()
    if (!oauthClient) {
      log.error("Google Workspace OAuth client is not configured")
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error: "Google Workspace OAuth is not configured. Contact IT.",
      })
    }

    const baseUrl = getIssuerUrl()
    const redirectUri = `${baseUrl}/agent-connect/callback`
    // OAuth `state` is only the nonce. We previously embedded the full JWT
    // (sub/agent/purpose/nonce/sig) which leaks via Google's logs, our
    // access logs, browser history, and HTTP Referer. The nonce alone is
    // sufficient: the callback recovers owner_email and agent_email from
    // the nonce row in psd_agent_workspace_consent_nonces (migration 072),
    // and the table validates one-time-use + age via UPDATE ... WHERE
    // consumed_at IS NULL plus a 24h window.
    const params = new URLSearchParams({
      client_id: oauthClient.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: payload.nonce,
      login_hint: payload.agent,
    })

    timer({ status: "success" })
    log.info("Consent token verified, OAuth URL generated", sanitizeForLogging({
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
    }))

    return createSuccess({
      valid: true,
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
      googleOAuthUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to verify consent link", {
      context: "verifyConsentAndGetOAuthUrl",
      requestId,
      operation: "verifyConsentAndGetOAuthUrl",
    })
  }
}

export interface OAuthCallbackResult {
  success: boolean
  ownerEmail?: string
  agentEmail?: string
  error?: string
}

/**
 * Exchange Google auth code for tokens and persist the workspace manifest.
 *
 * Order of writes is deliberate:
 *   1. Verify identity from DB (user lookup by email).
 *   2. Upsert the manifest row in `pending` state (no token yet, but the
 *      operator dashboard now reflects an in-flight connection).
 *   3. Write the refresh token to Secrets Manager.
 *   4. Mark the manifest row `active` with granted_scopes / verified_at.
 *
 * Why: a failure at step 3 leaves a `pending` row visible to operators
 * (so they know to retry) but no orphan secret. A failure at step 4 leaves
 * a token in Secrets Manager and a `pending` row — the operator can see
 * something is half-done and reconcile. Either way, the agent never sees
 * "secret present but no manifest" (which would let it use Workspace
 * access against an account the admin dashboard says isn't connected).
 */
async function exchangeAndStore(
  code: string,
  payload: { sub: string; agent: string },
  log: ReturnType<typeof createLogger>
): Promise<OAuthCallbackResult> {
  const oauthClient = await getOAuthClientCredentials()
  if (!oauthClient) {
    log.error("Google Workspace OAuth credentials not configured")
    return { success: false, error: "Google Workspace OAuth is not configured. Contact IT." }
  }
  const { client_id: clientId, client_secret: clientSecret } = oauthClient

  const baseUrl = getIssuerUrl()
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${baseUrl}/agent-connect/callback`,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!tokenResponse.ok) {
    // Google's error body can include the auth code (which is now spent
    // anyway) and the client_id; sanitize before logging.
    const errorBody = await tokenResponse.text()
    log.error(
      "Google token exchange failed",
      sanitizeForLogging({
        status: tokenResponse.status,
        ownerEmail: payload.sub,
        body: errorBody,
      })
    )
    return { success: false, error: "Failed to exchange authorization code with Google. Please request a new consent link from your agent and try again." }
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string
    refresh_token?: string
    scope?: string
    token_type: string
    expires_in: number
  }

  if (!tokenData.refresh_token) {
    log.error("Google did not return a refresh token", sanitizeForLogging({ ownerEmail: payload.sub }))
    return { success: false, error: "Google did not return a refresh token. Ensure the OAuth client is configured as Internal + In Production." }
  }

  const grantedScopes = tokenData.scope?.split(" ") ?? []

  // Guard: reject if Google returned an empty scope list (misconfigured OAuth client)
  if (grantedScopes.length === 0) {
    log.error("Google returned an empty scope list", sanitizeForLogging({ ownerEmail: payload.sub }))
    return {
      success: false,
      error: "Google returned no permissions. The OAuth client may be misconfigured. Contact IT.",
    }
  }

  // Validate that Google granted the minimum required scopes
  const REQUIRED_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
  ]
  const missingScopes = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s))
  if (missingScopes.length > 0) {
    log.error("Google granted insufficient scopes", sanitizeForLogging({
      ownerEmail: payload.sub,
      missing: missingScopes,
      granted: grantedScopes,
    }))
    return {
      success: false,
      error: `Google did not grant all required permissions. Missing: ${missingScopes.join(", ")}. Please try again and accept all requested permissions.`,
    }
  }

  const [user] = await executeQuery(
    (db) => db.select({ id: users.id }).from(users).where(eq(users.email, payload.sub)).limit(1),
    "findUserByEmail"
  )

  if (!user) {
    log.error("User not found in database — cannot store workspace token manifest", sanitizeForLogging({ ownerEmail: payload.sub }))
    return {
      success: false,
      error: "Your account was not found in the system. Contact IT for assistance.",
    }
  }

  // Construct the Secrets Manager ARN now (no I/O — used as a value on
  // the manifest row regardless of whether the secret write succeeds).
  const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2"
  const accountId = process.env.AWS_ACCOUNT_ID ?? ""
  const secretName = `psd-agent-creds/${environment}/user/${payload.sub}/google-workspace`
  const secretsManagerArn = accountId
    ? `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretName}`
    : null

  // Step 1: pending manifest row. If we crash before the secret write, the
  // operator dashboard shows pending — not "active" with no token to back it.
  await executeQuery(
    (db) =>
      db
        .insert(psdAgentWorkspaceTokens)
        .values({
          ownerUserId: user.id,
          ownerEmail: payload.sub,
          agentEmail: payload.agent,
          status: "pending",
          grantedScopes,
          secretsManagerArn,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: psdAgentWorkspaceTokens.ownerUserId,
          set: {
            agentEmail: payload.agent,
            status: "pending",
            grantedScopes,
            secretsManagerArn,
            revokedAt: null,
            updatedAt: new Date(),
          },
        }),
    "upsertWorkspaceTokenPending"
  )

  // Step 2: write the refresh token to Secrets Manager.
  await storeRefreshToken(payload.sub, {
    refresh_token: tokenData.refresh_token,
    granted_scopes: grantedScopes,
    obtained_at: new Date().toISOString(),
  })

  // Step 3: promote to active. Only here is the connection considered live
  // by both halves of the system (manifest + secret).
  await executeQuery(
    (db) =>
      db
        .update(psdAgentWorkspaceTokens)
        .set({
          status: "active",
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(psdAgentWorkspaceTokens.ownerUserId, user.id)),
    "promoteWorkspaceTokenActive"
  )

  return { success: true, ownerEmail: payload.sub, agentEmail: payload.agent }
}

/**
 * Handle the OAuth callback. The `state` parameter is the bare nonce (not a
 * JWT — see verifyConsentAndGetOAuthUrl). We look up owner_email and
 * agent_email from the nonce row, run the token exchange, and *only then*
 * mark the nonce consumed. This means a transient failure in the token
 * exchange (Google 5xx, network blip) leaves the nonce alive so the user
 * can retry without requesting a new consent link.
 *
 * This is a public action (no auth required) — the unconsumed, fresh nonce
 * IS the auth.
 */
export async function handleOAuthCallback(
  code: string,
  state: string
): Promise<ActionState<OAuthCallbackResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("handleOAuthCallback")
  const log = createLogger({ requestId, action: "handleOAuthCallback" })

  try {
    // Validate state shape before hitting the DB. The nonce is a 64-char
    // hex string per consent-link route. Anything else is an attack or a
    // truncated URL.
    if (!/^[0-9a-f]{64}$/.test(state)) {
      log.warn("OAuth callback received malformed state", { stateLength: state.length })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Invalid consent state. Ask your agent for a new consent link.",
      })
    }

    // Look up the nonce row — must exist, be unconsumed, and within 1h of
    // creation. The age window is the actual replay-protection horizon
    // (older nonces, even unconsumed, are no longer valid).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [nonceRow] = await executeQuery(
      (db) =>
        db
          .select({
            ownerEmail: psdAgentWorkspaceConsentNonces.ownerEmail,
            agentEmail: psdAgentWorkspaceConsentNonces.agentEmail,
          })
          .from(psdAgentWorkspaceConsentNonces)
          .where(
            sql`${psdAgentWorkspaceConsentNonces.nonce} = ${state}
                AND ${psdAgentWorkspaceConsentNonces.consumedAt} IS NULL
                AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
          )
          .limit(1),
      "lookupConsentNonce"
    )

    if (!nonceRow) {
      timer({ status: "error" })
      log.warn("Consent nonce not found, already consumed, or expired", {
        nonce: state.slice(0, 8) + "…",
      })
      return createSuccess({
        success: false,
        error: "This consent link has already been used or has expired. Ask your agent for a new one.",
      })
    }

    const payload = { sub: nonceRow.ownerEmail, agent: nonceRow.agentEmail }
    const result = await exchangeAndStore(code, payload, log)

    if (!result.success) {
      // Token exchange failed. Leave the nonce unconsumed so the user can
      // re-click the same link (Google may have transiently 5xx'd, or the
      // user closed the tab mid-flow). The rate limit (5/hour) prevents
      // abuse of this retry surface.
      timer({ status: "error" })
      return createSuccess(result)
    }

    // Success: now mark the nonce consumed. Atomic UPDATE protects against
    // a race where two concurrent callbacks both succeed at exchange — only
    // one will actually consume here, but both attempted writes are safe
    // because the manifest upsert is idempotent.
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
      "consumeConsentNonce"
    )

    timer({ status: "success" })
    log.info("OAuth callback completed", sanitizeForLogging({
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
    }))
    return createSuccess(result)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to complete OAuth callback", {
      context: "handleOAuthCallback",
      requestId,
      operation: "handleOAuthCallback",
    })
  }
}
