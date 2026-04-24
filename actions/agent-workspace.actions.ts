"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, and, isNull } from "drizzle-orm"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { users } from "@/lib/db/schema/tables/users"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import { storeRefreshToken } from "@/lib/agent-workspace/secrets-manager"
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

    const clientId = process.env.GOOGLE_WORKSPACE_CLIENT_ID
    if (!clientId) {
      log.error("GOOGLE_WORKSPACE_CLIENT_ID is not configured")
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error: "Google Workspace OAuth is not configured. Contact IT.",
      })
    }

    const baseUrl = getIssuerUrl()
    const redirectUri = `${baseUrl}/agent-connect/callback`
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: token,
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
 * Exchange Google auth code for tokens and upsert the workspace manifest.
 */
async function exchangeAndStore(
  code: string,
  payload: { sub: string; agent: string },
  log: ReturnType<typeof createLogger>
): Promise<OAuthCallbackResult> {
  const clientId = process.env.GOOGLE_WORKSPACE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_WORKSPACE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    log.error("Google Workspace OAuth credentials not configured")
    return { success: false, error: "Google Workspace OAuth is not configured. Contact IT." }
  }

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
    const errorBody = await tokenResponse.text()
    log.error("Google token exchange failed", { status: tokenResponse.status, body: errorBody })
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

  await storeRefreshToken(payload.sub, {
    refresh_token: tokenData.refresh_token,
    granted_scopes: grantedScopes,
    obtained_at: new Date().toISOString(),
  })

  // Upsert workspace token manifest
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

  // Construct the Secrets Manager ARN for the token manifest.
  // This mirrors the path used by storeRefreshToken in secrets-manager.ts.
  const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2"
  const accountId = process.env.AWS_ACCOUNT_ID ?? ""
  const secretName = `psd-agent-creds/${environment}/user/${payload.sub}/google-workspace`
  const secretsManagerArn = accountId
    ? `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretName}`
    : null

  await executeQuery(
    (db) =>
      db
        .insert(psdAgentWorkspaceTokens)
        .values({
          ownerUserId: user.id,
          ownerEmail: payload.sub,
          agentEmail: payload.agent,
          status: "active",
          grantedScopes,
          secretsManagerArn,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: psdAgentWorkspaceTokens.ownerUserId,
          set: {
            agentEmail: payload.agent,
            status: "active",
            grantedScopes,
            secretsManagerArn,
            lastVerifiedAt: new Date(),
            revokedAt: null,
            updatedAt: new Date(),
          },
        }),
    "upsertWorkspaceToken"
  )

  return { success: true, ownerEmail: payload.sub, agentEmail: payload.agent }
}

/**
 * Handle the OAuth callback: verify state, exchange code for tokens,
 * store refresh token in Secrets Manager, upsert workspace token manifest.
 *
 * This is a public action (no auth required) — the signed state token IS the auth.
 */
export async function handleOAuthCallback(
  code: string,
  state: string
): Promise<ActionState<OAuthCallbackResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("handleOAuthCallback")
  const log = createLogger({ requestId, action: "handleOAuthCallback" })

  try {
    const payload = await verifyConsentToken(state)
    if (!payload) {
      timer({ status: "error" })
      return createSuccess({ success: false, error: "Invalid or expired consent link. Ask your agent for a new one." })
    }

    // Atomically consume the nonce
    const consumeResult = await executeQuery(
      (db) =>
        db
          .update(psdAgentWorkspaceConsentNonces)
          .set({ consumedAt: new Date() })
          .where(and(eq(psdAgentWorkspaceConsentNonces.nonce, payload.nonce), isNull(psdAgentWorkspaceConsentNonces.consumedAt)))
          .returning({ nonce: psdAgentWorkspaceConsentNonces.nonce }),
      "consumeConsentNonce"
    )

    if (consumeResult.length === 0) {
      timer({ status: "error" })
      log.warn("Consent nonce already consumed during callback", { nonce: payload.nonce })
      return createSuccess({ success: false, error: "This consent link has already been used. Ask your agent for a new one." })
    }

    const result = await exchangeAndStore(code, payload, log)

    timer({ status: result.success ? "success" : "error" })
    if (result.success) {
      log.info("OAuth callback completed", sanitizeForLogging({ ownerEmail: payload.sub, agentEmail: payload.agent }))
    }
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
