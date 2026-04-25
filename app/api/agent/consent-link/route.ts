/**
 * Agent Consent Link Generator
 *
 * POST /api/agent/consent-link
 * Auth: Bearer {shared-secret} from psd-agent/{env}/internal-api-key
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
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import { randomBytes, timingSafeEqual } from "node:crypto"

const log = createLogger({ module: "agent-consent-link" })

/**
 * Resolve the shared secret. Prefers AGENT_INTERNAL_API_KEY env var (local
 * dev) and falls back to Secrets Manager at AGENT_INTERNAL_API_KEY_SECRET_ID
 * (ECS). The SM read is cached for 5 minutes, so repeated calls are cheap.
 * Returns null if the secret isn't configured yet — caller treats that as
 * unauthorized so the endpoint fails closed.
 */
async function getExpectedSecret(): Promise<string | null> {
  const envVal = process.env.AGENT_INTERNAL_API_KEY
  if (envVal) return envVal

  // Env var name is `_SECRET_ID` (not `_ARN`) — Secrets Manager accepts a
  // bare secret name *or* a full ARN; we use the name. Misnaming as `_ARN`
  // led to operator confusion during rollout.
  const id = process.env.AGENT_INTERNAL_API_KEY_SECRET_ID
  if (!id) return null

  return getSecretString(id)
}

/**
 * Validate the shared secret from the Authorization header.
 * In production, this secret lives in Secrets Manager at
 * psd-agent/{env}/internal-api-key and is fetched lazily. For local dev,
 * set AGENT_INTERNAL_API_KEY directly.
 */
async function validateSharedSecret(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return false
  }

  const token = authHeader.slice(7)
  const expectedSecret = await getExpectedSecret()
  if (!expectedSecret) {
    log.error("consent-link internal secret is not configured — rejecting request")
    return false
  }

  // Constant-time comparison. The expected secret is a CDK-generated
  // 48-char token with fixed length per environment, so a length mismatch
  // does not leak anything an attacker couldn't already derive from the
  // deploy manifest. On mismatch we still run timingSafeEqual against
  // itself so the code path has stable wall-clock regardless of outcome.
  const tokenBuf = Buffer.from(token)
  const expectedBuf = Buffer.from(expectedSecret)
  if (tokenBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(tokenBuf, expectedBuf)
}

/**
 * Rate-limit check: max 5 consent links per ownerEmail per hour.
 * Returns true if under the limit.
 *
 * NOTE: This check is not atomic — two concurrent requests could both read
 * count=4, pass the check, and both insert (yielding 6 links). This is
 * acceptable for a low-traffic agent consent endpoint. For strict enforcement,
 * consider a SELECT ... FOR UPDATE lock or a Redis counter.
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

  return (result?.count ?? 0) < 5
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  // Auth
  if (!(await validateSharedSecret(request))) {
    log.warn("Unauthorized consent-link request", { requestId })
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    )
  }

  // Parse body
  let body: { ownerEmail?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    )
  }

  const { ownerEmail } = body
  if (!ownerEmail || typeof ownerEmail !== "string" || !SAFE_EMAIL_RE.test(ownerEmail)) {
    return NextResponse.json(
      { error: "ownerEmail is required and must be a valid email" },
      { status: 400 }
    )
  }

  // Rate limit
  const withinLimit = await checkRateLimit(ownerEmail)
  if (!withinLimit) {
    log.warn("Consent link rate limit exceeded", sanitizeForLogging({ ownerEmail, requestId }))
    return NextResponse.json(
      { error: "Rate limit exceeded — max 5 links per hour per user" },
      { status: 429, headers: { "Retry-After": "3600" } }
    )
  }

  // Derive agent email from owner email: hagelk@psd401.net -> agnt_hagelk@psd401.net
  const [localPart, domain] = ownerEmail.split("@")
  const agentEmail = `agnt_${localPart}@${domain}`

  // Generate nonce and persist it. agent_email is stored on the row so the
  // OAuth callback can recover identity from the nonce alone (the OAuth
  // state parameter no longer carries the full JWT — see migration 072).
  const nonce = randomBytes(32).toString("hex")

  await executeQuery(
    (db) =>
      db
        .insert(psdAgentWorkspaceConsentNonces)
        .values({
          nonce,
          ownerEmail,
          agentEmail,
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
  })

  // Build the consent URL
  const baseUrl = getIssuerUrl()
  const url = `${baseUrl}/agent-connect?token=${encodeURIComponent(token)}`

  log.info("Consent link generated", sanitizeForLogging({ ownerEmail, agentEmail, requestId }))

  return NextResponse.json({ url })
}
