/**
 * Agent Consent Link Generator
 *
 * POST /api/agent/consent-link
 * Auth: short-lived router-signed invocation context
 *
 * Mints a signed, short-lived consent URL that the agent can give to a user
 * in Google Chat. The user clicks it to start the Google OAuth flow.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { signConsentToken } from "@/lib/agent-workspace/consent-token"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { sql } from "drizzle-orm"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import { randomBytes } from "node:crypto"

const log = createLogger({ module: "agent-consent-link" })

/**
 * The credential slot a consent link is capturing.
 *
 * `agent_account` is RETIRED (#1232): Workspace operations now execute only
 * through the owner-bound operation broker. This route rejects the old slot.
 */
type Kind = "user_account" | "cognito_data" | "plaud" | "canva" | "aistudio"
const ALLOWED_KINDS: Kind[] = [
  "user_account",
  "cognito_data",
  "plaud",
  "canva",
  "aistudio",
]

/**
 * Map a consent kind to its public start page. cognito_data captures a
 * NextAuth session's Cognito refresh token; plaud/canva start their own
 * OAuth flow; everything else routes to the Google Workspace OAuth page.
 */
function resolveConsentPath(kind: Kind): string {
  switch (kind) {
    case "cognito_data":
      return "/agent-connect-data"
    case "plaud":
      return "/agent-connect-plaud"
    case "canva":
      return "/agent-connect-canva"
    case "aistudio":
      return "/agent-connect-aistudio"
    default:
      return "/agent-connect"
  }
}

/**
 * Rate-limit check: max 20 consent links per ownerEmail per hour.
 *
 * Sized for "user clicks broken link → asks agent for a fresh link → repeat"
 * during rollout. The original 5/hour cap punished legitimate retries when a
 * URL was mangled in Chat (see incident 2026-04-27). Keep the cap — the
 * endpoint is open with a shared secret — but make it generous enough that
 * recovery is not blocked.
 *
 * NOTE: This check is not atomic — two concurrent requests could both read
 * count=N, pass the check, and both insert. Acceptable for low traffic.
 */
async function checkRateLimit(ownerEmail: string): Promise<boolean> {
  // postgres.js doesn't auto-serialize Date inside raw sql templates (Drizzle
  // only converts when it knows the column type via the column ref). Pass an
  // ISO string and let Postgres cast to timestamp.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const [result] = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(psdAgentWorkspaceConsentNonces)
        .where(
          sql`${psdAgentWorkspaceConsentNonces.ownerEmail} = ${ownerEmail}
              AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}::timestamptz`
        ),
    "checkConsentLinkRateLimit"
  )

  return (result?.count ?? 0) < 20
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  const invocationContext = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!invocationContext) {
    log.warn("Consent-link request has no authorized owner context", { requestId })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Parse body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    )
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 }
    )
  }
  const requestBody = body as Record<string, unknown>
  for (const field of ["ownerEmail", "userEmail", "userId"] as const) {
    if (Object.prototype.hasOwnProperty.call(requestBody, field)) {
      return NextResponse.json(
        { error: "Owner selectors are not accepted" },
        { status: 400 }
      )
    }
  }
  const ownerEmail = invocationContext.ownerEmail

  // The agent slot no longer has a consent flow (#1232) — reject it explicitly
  // so an un-updated skill fails loudly rather than minting a dead nonce.
  if (requestBody.kind === "agent_account") {
    return NextResponse.json(
      {
        error:
          "agent_account consent is retired. Workspace operations use the " +
          "owner-bound operation broker; no consent link is issued for this slot.",
      },
      { status: 400 }
    )
  }

  // Validate kind. Default to 'user_account' (the only Google-Workspace consent
  // slot that remains) for skills that don't pass kind explicitly.
  if (
    requestBody.kind !== undefined &&
    (typeof requestBody.kind !== "string" ||
      !(ALLOWED_KINDS as readonly string[]).includes(requestBody.kind))
  ) {
    return NextResponse.json(
      { error: "kind must be 'user_account', 'cognito_data', 'plaud', 'canva', or 'aistudio' if provided" },
      { status: 400 }
    )
  }
  const kind: Kind =
    requestBody.kind !== undefined &&
    typeof requestBody.kind === "string" &&
    (ALLOWED_KINDS as readonly string[]).includes(requestBody.kind)
      ? (requestBody.kind as Kind)
      : "user_account"

  // Rate limit
  const withinLimit = await checkRateLimit(ownerEmail)
  if (!withinLimit) {
    log.warn("Consent link rate limit exceeded", sanitizeForLogging({ ownerEmail, requestId, kind }))
    return NextResponse.json(
      { error: "Rate limit exceeded — max 20 links per hour per user" },
      { status: 429, headers: { "Retry-After": "3600" } }
    )
  }

  // Derive agent email from owner email: hagelk@psd401.net -> agnt_hagelk@psd401.net
  const [localPart, domain] = ownerEmail.split("@")
  const agentEmail = `agnt_${localPart}@${domain}`

  // Generate nonce and persist it. agent_email + token_kind are stored on the
  // row so the OAuth callback can recover identity AND target slot from the
  // nonce alone (the OAuth state parameter no longer carries the full JWT —
  // see migration 072).
  const nonce = randomBytes(32).toString("hex")

  // PKCE (S256) code_verifier for the PKCE-based flows (Plaud, Canva).
  // base64url(32 bytes) = 43 chars, within RFC 7636's 43–128 range. Stored
  // server-side; only the S256 challenge ever leaves in a URL.
  const codeVerifier =
    kind === "plaud" || kind === "canva" || kind === "aistudio"
      ? randomBytes(32).toString("base64url")
      : null

  await executeQuery(
    (db) =>
      db
        .insert(psdAgentWorkspaceConsentNonces)
        .values({
          nonce,
          ownerEmail,
          agentEmail,
          tokenKind: kind,
          codeVerifier,
        }),
    "insertConsentNonce"
  )

  // Sign the consent token. The JWT is the URL token (carried in chat) so a
  // forged URL can't redirect to Google for the wrong user. The OAuth state,
  // however, is just `nonce` — see verifyConsentAndGetOAuthUrl.
  const token = await signConsentToken({
    sub: ownerEmail,
    agent: agentEmail,
    purpose: "workspace-consent",
    nonce,
    kind,
  })

  // Build the consent URL. cognito_data has its own dedicated page that
  // captures a NextAuth session's Cognito refresh token; the other kinds
  // route to the Google Workspace OAuth start page.
  const baseUrl = getIssuerUrl()
  const url = `${baseUrl}${resolveConsentPath(kind)}?token=${encodeURIComponent(token)}`

  log.info("Consent link generated", sanitizeForLogging({ ownerEmail, agentEmail, kind, requestId }))

  return NextResponse.json({ url })
}
