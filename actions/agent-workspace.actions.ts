"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, and, isNull } from "drizzle-orm"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { users } from "@/lib/db/schema/tables/users"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"

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
    // 1. Verify the JWT
    const payload = await verifyConsentToken(token)
    if (!payload) {
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error: "Invalid or expired consent link. Ask your agent for a new one.",
      })
    }

    // 2. Check the nonce hasn't been consumed
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

    // 3. Build the Google OAuth URL
    const clientId = process.env.GOOGLE_WORKSPACE_CLIENT_ID
    if (!clientId) {
      log.error("GOOGLE_WORKSPACE_CLIENT_ID is not configured")
      timer({ status: "error" })
      return createSuccess({
        valid: false,
        error: "Google Workspace OAuth is not configured. Contact IT.",
      })
    }

    const baseUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
    const redirectUri = `${baseUrl}/agent-connect/callback`

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      // Pass the original signed token as state so the callback can verify it
      state: token,
      // Login hint: pre-fill the agent account email
      login_hint: payload.agent,
    })

    const googleOAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`

    timer({ status: "success" })
    log.info("Consent token verified, OAuth URL generated", {
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
    })

    return createSuccess({
      valid: true,
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
      googleOAuthUrl,
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
    // 1. Verify the state token
    const payload = await verifyConsentToken(state)
    if (!payload) {
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Invalid or expired consent link. Ask your agent for a new one.",
      })
    }

    // 2. Verify nonce is unconsumed, then consume it atomically
    const consumeResult = await executeQuery(
      (db) =>
        db
          .update(psdAgentWorkspaceConsentNonces)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(psdAgentWorkspaceConsentNonces.nonce, payload.nonce),
              isNull(psdAgentWorkspaceConsentNonces.consumedAt)
            )
          )
          .returning({ nonce: psdAgentWorkspaceConsentNonces.nonce }),
      "consumeConsentNonce"
    )

    if (consumeResult.length === 0) {
      timer({ status: "error" })
      log.warn("Consent nonce already consumed during callback", { nonce: payload.nonce })
      return createSuccess({
        success: false,
        error: "This consent link has already been used. Ask your agent for a new one.",
      })
    }

    // 3. Exchange authorization code for tokens
    const clientId = process.env.GOOGLE_WORKSPACE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_WORKSPACE_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      log.error("Google Workspace OAuth credentials not configured")
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Google Workspace OAuth is not configured. Contact IT.",
      })
    }

    const baseUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
    const redirectUri = `${baseUrl}/agent-connect/callback`

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    })

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text()
      log.error("Google token exchange failed", {
        status: tokenResponse.status,
        body: errorBody,
      })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Failed to exchange authorization code with Google. Try again or contact IT.",
      })
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string
      refresh_token?: string
      scope?: string
      token_type: string
      expires_in: number
    }

    if (!tokenData.refresh_token) {
      log.error("Google did not return a refresh token", {
        ownerEmail: payload.sub,
        scopes: tokenData.scope,
      })
      timer({ status: "error" })
      return createSuccess({
        success: false,
        error: "Google did not return a refresh token. Ensure the OAuth client is configured as Internal + In Production.",
      })
    }

    const grantedScopes = tokenData.scope?.split(" ") ?? []

    // 4. Store refresh token in Secrets Manager
    // In production, this uses the AWS SDK. For local dev, we store in an env-var
    // backed mock (the actual secret write is a no-op locally).
    await storeRefreshToken(payload.sub, {
      refresh_token: tokenData.refresh_token,
      granted_scopes: grantedScopes,
      obtained_at: new Date().toISOString(),
    })

    // 5. Upsert workspace token manifest in the database
    // Look up the user by email to get their user ID
    const [user] = await executeQuery(
      (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, payload.sub))
          .limit(1),
      "findUserByEmail"
    )

    if (user) {
      // Upsert using ON CONFLICT on the unique owner_user_id index
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
              lastVerifiedAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: psdAgentWorkspaceTokens.ownerUserId,
              set: {
                agentEmail: payload.agent,
                status: "active",
                grantedScopes,
                lastVerifiedAt: new Date(),
                revokedAt: null,
                updatedAt: new Date(),
              },
            }),
        "upsertWorkspaceToken"
      )
    } else {
      log.warn("User not found in database for workspace token upsert", {
        ownerEmail: payload.sub,
      })
    }

    timer({ status: "success" })
    log.info("OAuth callback completed successfully", {
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
      scopeCount: grantedScopes.length,
    })

    return createSuccess({
      success: true,
      ownerEmail: payload.sub,
      agentEmail: payload.agent,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to complete OAuth callback", {
      context: "handleOAuthCallback",
      requestId,
      operation: "handleOAuthCallback",
    })
  }
}

/**
 * Store the refresh token in AWS Secrets Manager.
 * In production, this writes to psd-agent-creds/{env}/user/{email}/google-workspace.
 * For local dev, this is a no-op (refresh tokens are not stored locally).
 */
async function storeRefreshToken(
  ownerEmail: string,
  tokenData: {
    refresh_token: string
    granted_scopes: string[]
    obtained_at: string
  }
): Promise<void> {
  const log = createLogger({ module: "agent-workspace-secrets" })
  const environment = process.env.DEPLOY_ENVIRONMENT ?? "dev"
  const secretId = `psd-agent-creds/${environment}/user/${ownerEmail}/google-workspace`

  // Skip Secrets Manager in local development
  if (process.env.DATABASE_URL?.includes("localhost")) {
    log.info("Local dev mode — skipping Secrets Manager write", { secretId })
    return
  }

  try {
    const { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand, ResourceNotFoundException } = await import("@aws-sdk/client-secrets-manager")
    const client = new SecretsManagerClient({})

    try {
      await client.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: JSON.stringify(tokenData),
        })
      )
      log.info("Refresh token stored in Secrets Manager", { secretId })
    } catch (error) {
      // If the secret doesn't exist yet, create it
      if (error instanceof ResourceNotFoundException) {
        await client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: JSON.stringify(tokenData),
            Description: `Google Workspace refresh token for agent of ${ownerEmail}`,
            Tags: [
              { Key: "Environment", Value: environment },
              { Key: "ManagedBy", Value: "aistudio" },
              { Key: "OwnerEmail", Value: ownerEmail },
            ],
          })
        )
        log.info("Refresh token secret created in Secrets Manager", { secretId })
      } else {
        throw error
      }
    }
  } catch (error) {
    log.error("Failed to store refresh token in Secrets Manager", {
      secretId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
