"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { eq, and, isNull, sql } from "drizzle-orm"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { users } from "@/lib/db/schema/tables/users"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"
import { storeRefreshToken, getSecretJson } from "@/lib/agent-workspace/secrets-manager"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { addUserRole } from "@/lib/db/drizzle/user-roles"

/**
 * OAuth scopes requested per token kind (#912 Phase 1).
 *
 * agent_account: the agnt_<uniqname>@psd401.net identity. Broad scopes
 * because the agent owns its own Calendar/Drive/Chat presence and may need
 * write access to shared resources.
 *
 * user_account: the human's own identity. NARROW Phase 1 scopes only —
 * read mail + create drafts, manage tasks, scoped Drive files. No send,
 * no destructive operations. Calendar scope included so the agent can
 * write events directly to the user's calendar (Calendar via sharing
 * already worked, but the user wants the agent to be able to make
 * changes from the user-account side as well).
 */
const SCOPES_BY_KIND: Record<"agent_account" | "user_account", string[]> = {
  agent_account: [
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
  ],
  user_account: [
    // Phase 1: read mail and create drafts only. No send.
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    // Full calendar so the agent can write events with markers (per user
    // direction 2026-04-26: "the way it is working right now is fine").
    "https://www.googleapis.com/auth/calendar",
    // Tasks for to-do management.
    "https://www.googleapis.com/auth/tasks",
    // Drive scoped to files the app creates or the user explicitly opens
    // with the app — narrowest possible Drive grant.
    "https://www.googleapis.com/auth/drive.file",
    "openid",
    "email",
    "profile",
  ],
}

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
  /**
   * Which OAuth slot this consent is for (#912 Phase 1):
   *   'agent_account' — user logs in as agnt_<uniqname>, broad scopes
   *   'user_account'  — user logs in as themself, narrow Phase 1 scopes
   * The consent UI renders different copy based on this field.
   */
  kind?: "agent_account" | "user_account"
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
    //
    // Scopes and login_hint are kind-dependent:
    //   agent_account → log in as agnt_<uniqname>, broad agent scopes
    //   user_account  → log in as the user themself, narrow Phase 1 scopes
    const kind = payload.kind ?? "agent_account"
    const scopes = SCOPES_BY_KIND[kind]
    const loginHint = kind === "user_account" ? payload.sub : payload.agent
    const params = new URLSearchParams({
      client_id: oauthClient.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: payload.nonce,
      login_hint: loginHint,
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
      kind,
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

/**
 * Auto-provision a PSD staff user during the agent OAuth callback when they
 * have no row in the `users` table yet. Called only after we've already
 * exchanged the auth code with Google, so we can fetch their name from
 * Google userinfo using the access_token.
 *
 * Returns `{ id }` on success, `null` if provisioning fails (caller surfaces
 * the generic "account not found" error to the user). Numeric-prefix emails
 * (student IDs) are NOT auto-provisioned — the agent platform is staff-only
 * for now, so a numeric prefix is treated as a misrouted request.
 */
async function provisionAgentUser(
  email: string,
  accessToken: string,
  log: ReturnType<typeof createLogger>
): Promise<{ id: number } | null> {
  const username = email.split("@")[0] ?? ""
  const isNumeric = /^\d+$/.test(username)
  if (isNumeric) {
    log.error("Refusing to auto-provision numeric-prefix email via agent OAuth", sanitizeForLogging({ email }))
    return null
  }

  // Fetch first/last name from Google userinfo. The agent OAuth scope set
  // includes `profile`, so this endpoint is authorized. Fall back to deriving
  // a placeholder name from the email local-part if userinfo is unavailable
  // — provisioning must not fail just because Google's profile API is slow.
  let firstName: string | null = null
  let lastName: string | null = null
  try {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const info = (await res.json()) as { given_name?: string; family_name?: string; name?: string }
      firstName = info.given_name ?? null
      lastName = info.family_name ?? null
    } else {
      log.warn("Google userinfo returned non-OK; using email-derived name", { status: res.status })
    }
  } catch (err) {
    log.warn("Google userinfo fetch failed; using email-derived name", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (!firstName) firstName = username || "User"

  // SELECT-then-INSERT inside a transaction to avoid a duplicate row if the
  // user double-clicks the consent flow. Email is indexed but not unique, so
  // we serialize within the transaction by re-checking under the lock window.
  const userId = await executeTransaction(async (tx) => {
    const [again] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (again) return again.id

    const [created] = await tx
      .insert(users)
      .values({ email, firstName, lastName })
      .returning({ id: users.id })
    return created.id
  }, "provisionAgentUser")

  // Role assignment is a side-effect — keep it OUT of the transaction so a
  // role-table miss doesn't roll back the user creation. Mirrors
  // resolve-user.ts:130-158 behavior: log and continue if role assignment
  // fails. The user can still complete OAuth; their next web sign-in will
  // re-run role assignment via getCurrentUserAction.
  try {
    await addUserRole(userId, "staff")
    log.info("Agent OAuth auto-provisioned staff user", sanitizeForLogging({ email, userId }))
  } catch (err) {
    log.warn("Auto-provisioned user but role assignment failed — will retry on web sign-in", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return { id: userId }
}

async function exchangeAndStore(
  code: string,
  payload: { sub: string; agent: string; kind: "agent_account" | "user_account" },
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

  // Validate that Google granted the minimum required scopes for this kind.
  // Per-kind required set is the subset of SCOPES_BY_KIND that's truly
  // load-bearing — openid/email/profile are nice-to-have, not required.
  const REQUIRED_BY_KIND: Record<"agent_account" | "user_account", string[]> = {
    agent_account: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
    ],
    user_account: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/tasks",
    ],
  }
  const REQUIRED_SCOPES = REQUIRED_BY_KIND[payload.kind]
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

  const [existing] = await executeQuery(
    (db) => db.select({ id: users.id }).from(users).where(eq(users.email, payload.sub)).limit(1),
    "findUserByEmail"
  )

  // Auto-provision PSD staff who haven't logged into the AI Studio web UI yet
  // — they're meeting the agent in Google Chat first. The cognito_sub stays
  // null and gets linked on their first web sign-in via lib/auth/resolve-user.ts
  // (the email-based migration path). Default role is `staff`; numeric-prefix
  // emails (student IDs) keep the strict-lookup behavior since the agent
  // platform is not aimed at students.
  const user = existing ?? (await provisionAgentUser(payload.sub, tokenData.access_token, log))
  if (!user) {
    return {
      success: false,
      error: "Your account was not found in the system. Contact IT for assistance.",
    }
  }

  // Step 1: pending manifest row. If we crash before the secret write, the
  // operator dashboard shows pending — not "active" with no token to back it.
  // The ARN column is left null until step 3 because we don't know the real
  // ARN until Secrets Manager returns it (ARNs always end in a 6-char random
  // suffix that isn't part of the path).
  //
  // Conflict target is composite (owner_user_id, token_kind) so the agent_account
  // and user_account rows coexist for the same user (#912 Phase 1).
  await executeQuery(
    (db) =>
      db
        .insert(psdAgentWorkspaceTokens)
        .values({
          ownerUserId: user.id,
          ownerEmail: payload.sub,
          agentEmail: payload.agent,
          tokenKind: payload.kind,
          status: "pending",
          grantedScopes,
          secretsManagerArn: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [psdAgentWorkspaceTokens.ownerUserId, psdAgentWorkspaceTokens.tokenKind],
          set: {
            agentEmail: payload.agent,
            status: "pending",
            grantedScopes,
            secretsManagerArn: null,
            revokedAt: null,
            updatedAt: new Date(),
          },
        }),
    "upsertWorkspaceTokenPending"
  )

  // Step 2: write the refresh token to the kind-specific Secrets Manager
  // slot. Returns the *real* ARN (with the 6-char suffix AWS appends), not
  // a hand-built one. Stored on the manifest below so operators clicking
  // through from the dashboard get a working AWS Console link.
  const realSecretArn = await storeRefreshToken(
    payload.sub,
    {
      refresh_token: tokenData.refresh_token,
      granted_scopes: grantedScopes,
      obtained_at: new Date().toISOString(),
    },
    payload.kind
  )

  // Step 3: promote to active. Only here is the connection considered live
  // by both halves of the system (manifest + secret).
  //
  // NOTE on dual-write semantics for the psd-workspace agent skill:
  //   The skill (infra/agent-image/skills/psd-workspace/common.js) reads the
  //   refresh token directly from Secrets Manager — it never consults this
  //   manifest row. As soon as step 2 above completes, the agent can use
  //   Workspace access. The `pending` → `active` transition gates only the
  //   admin dashboard / operator visibility, not the runtime. This is why a
  //   crash between step 2 and step 3 doesn't break agent functionality —
  //   the user retains a working connection; the dashboard just shows
  //   `pending` until reconciled.
  //
  // Update WHERE clause is composite — only the row matching this kind is
  // promoted, leaving the other slot (if any) unchanged.
  await executeQuery(
    (db) =>
      db
        .update(psdAgentWorkspaceTokens)
        .set({
          status: "active",
          secretsManagerArn: realSecretArn,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(psdAgentWorkspaceTokens.ownerUserId, user.id),
            eq(psdAgentWorkspaceTokens.tokenKind, payload.kind)
          )
        ),
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
    if (!/^[\da-f]{64}$/.test(state)) {
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
    //
    // token_kind is read from the row so the callback writes to the correct
    // slot (agent_account vs user_account) without trusting the OAuth state
    // for that information (state is just the bare nonce — see migration 072).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [nonceRow] = await executeQuery(
      (db) =>
        db
          .select({
            ownerEmail: psdAgentWorkspaceConsentNonces.ownerEmail,
            agentEmail: psdAgentWorkspaceConsentNonces.agentEmail,
            tokenKind: psdAgentWorkspaceConsentNonces.tokenKind,
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

    const payload = {
      sub: nonceRow.ownerEmail,
      agent: nonceRow.agentEmail,
      kind: nonceRow.tokenKind,
    }
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
