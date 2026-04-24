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
import { createLogger, generateRequestId } from "@/lib/logger"
import { signConsentToken } from "@/lib/agent-workspace/consent-token"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import { sql } from "drizzle-orm"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { randomBytes, timingSafeEqual } from "node:crypto"

const log = createLogger({ module: "agent-consent-link" })

/**
 * Validate the shared secret from the Authorization header.
 * In production, this secret is stored in Secrets Manager at
 * psd-agent/{env}/internal-api-key. For local dev, use the
 * AGENT_INTERNAL_API_KEY env var.
 */
function validateSharedSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return false
  }

  const token = authHeader.slice(7)
  const expectedSecret = process.env.AGENT_INTERNAL_API_KEY
  if (!expectedSecret) {
    log.error("AGENT_INTERNAL_API_KEY is not configured — rejecting request")
    return false
  }

  const a = Buffer.from(token)
  const b = Buffer.from(expectedSecret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
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
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

  const [result] = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(psdAgentWorkspaceConsentNonces)
        .where(
          sql`${psdAgentWorkspaceConsentNonces.ownerEmail} = ${ownerEmail}
              AND ${psdAgentWorkspaceConsentNonces.createdAt} > ${oneHourAgo}`
        ),
    "checkConsentLinkRateLimit"
  )

  return (result?.count ?? 0) < 5
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  // Auth
  if (!validateSharedSecret(request)) {
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
    log.warn("Consent link rate limit exceeded", { ownerEmail, requestId })
    return NextResponse.json(
      { error: "Rate limit exceeded — max 5 links per hour per user" },
      { status: 429 }
    )
  }

  // Derive agent email from owner email: hagelk@psd401.net -> agnt_hagelk@psd401.net
  const [localPart, domain] = ownerEmail.split("@")
  const agentEmail = `agnt_${localPart}@${domain}`

  // Generate nonce and persist it
  const nonce = randomBytes(32).toString("hex")

  await executeQuery(
    (db) =>
      db
        .insert(psdAgentWorkspaceConsentNonces)
        .values({
          nonce,
          ownerEmail,
        }),
    "insertConsentNonce"
  )

  // Sign the consent token
  const token = await signConsentToken({
    sub: ownerEmail,
    agent: agentEmail,
    purpose: "workspace-consent",
    nonce,
  })

  // Build the consent URL
  const baseUrl = getIssuerUrl()
  const url = `${baseUrl}/agent-connect?token=${encodeURIComponent(token)}`

  log.info("Consent link generated", { ownerEmail, agentEmail, requestId })

  return NextResponse.json({ url })
}
