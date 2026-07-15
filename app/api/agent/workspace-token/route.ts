/**
 * Agent Workspace DWD Token Broker
 *
 * POST /api/agent/workspace-token
 * Auth: Bearer {shared-secret} from psd-agent/{env}/internal-api-key
 *
 * Mints a short-lived (~1h) Google access token for the caller's own agent
 * account (agnt_<owner-localpart>@psd401.net) via domain-wide delegation. This
 * replaces the retired agent-slot OAuth consent flow (#1232) — no human ever
 * signs in as an agent account, and no agent-slot refresh token is stored.
 *
 * Request:  { ownerEmail }
 * Response: { accessToken, expiresAt }              (200)
 *           { status: "account-not-provisioned" }   (404 — agnt_ account not made yet)
 *           { error }                                (400 / 401 / 429 / 503)
 *
 * HARD INVARIANT: the target account is ALWAYS derived server-side from
 * ownerEmail (deriveAgentEmail). A caller-supplied target is impossible — the
 * body has no such field — which keeps the domain-wide credential usable only
 * for `agnt_` accounts (never a human mailbox).
 *
 * SECURITY / KNOWN LIMITATION (codex review P1, #1232 open item): the caller is
 * authenticated ONLY by the shared internal secret, then `ownerEmail` is trusted
 * from the body. The agent runtime can read that secret, so a prompt-driven
 * agent could request a token for a DIFFERENT owner's `agnt_` account. Current
 * containment: the derivation guard confines the blast radius to `agnt_`
 * accounts (agent-generated content, never a human's mailbox), and the secret is
 * a container-only credential. Binding the token to a *verified* caller identity
 * (a signed owner assertion injected by the OpenClaw runtime, not a body field)
 * is the documented follow-up in #1232 ("If OpenClaw can inject the signed-in
 * user's verified email…") and requires runtime support that does not exist yet.
 *
 * Part of #1232.
 */

import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { validateInternalSecret } from "@/lib/agent-workspace/internal-auth"
import {
  mintAgentWorkspaceToken,
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"

const log = createLogger({ module: "agent-workspace-token" })

/**
 * Per-owner mint rate limit (defense-in-depth behind the shared secret). The
 * cap is generous — a token lasts ~1h and the skill caches it within that
 * window, so legitimate minting is roughly hourly per owner. Fixed 1h window.
 *
 * NOTE: in-memory per-task (ECS runs multiple tasks) — the same non-atomic,
 * best-effort tradeoff consent-link documents. This bounds abuse of a single
 * task, not the fleet; a fleet-wide guard would need shared state (Redis/DB).
 */
const RATE_LIMIT_PER_HOUR = Number(process.env.AGENT_WORKSPACE_TOKEN_RATE_LIMIT) || 120
const RATE_WINDOW_MS = 60 * 60 * 1000
const _mintWindow = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(ownerEmail: string): boolean {
  const now = Date.now()
  const entry = _mintWindow.get(ownerEmail)
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    _mintWindow.set(ownerEmail, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= RATE_LIMIT_PER_HOUR) return false
  entry.count += 1
  return true
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  if (!(await validateInternalSecret(request))) {
    log.warn("Unauthorized workspace-token request", { requestId })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // request.json() can return a bare `null` / non-object literal — guard before
  // destructuring so a null body is a 400, not a 500 (gemini review).
  const rawOwnerEmail = body && typeof body === "object" ? (body as { ownerEmail?: unknown }).ownerEmail : undefined
  if (!rawOwnerEmail || typeof rawOwnerEmail !== "string" || !SAFE_EMAIL_RE.test(rawOwnerEmail)) {
    return NextResponse.json(
      { error: "ownerEmail is required and must be a valid email" },
      { status: 400 }
    )
  }

  // Normalize BEFORE both the rate-limit key and deriveAgentEmail — otherwise
  // case-shuffling the same address (e.g. Hagelk@ vs hagelk@) bypasses the
  // rate limit, since Google treats both as the same mailbox (claude review).
  const ownerEmail = rawOwnerEmail.toLowerCase()

  if (!checkRateLimit(ownerEmail)) {
    log.warn("Workspace-token rate limit exceeded", sanitizeForLogging({ ownerEmail, requestId }))
    return NextResponse.json(
      { error: `Rate limit exceeded — max ${RATE_LIMIT_PER_HOUR} tokens per hour per user` },
      { status: 429, headers: { "Retry-After": "3600" } }
    )
  }

  try {
    const { accessToken, expiresAt, agentEmail } = await mintAgentWorkspaceToken(ownerEmail)
    // Audit trail for a domain-wide credential — owner, agent, requestId. Never
    // the token value.
    log.info("Workspace token minted", sanitizeForLogging({ ownerEmail, agentEmail, expiresAt, requestId }))
    return NextResponse.json({ accessToken, expiresAt })
  } catch (err) {
    if (err instanceof AccountNotProvisionedError) {
      // Distinct, expected outcome — the agnt_ account doesn't exist yet. The
      // provisioning flow (#1233) also uses this endpoint as its existence probe.
      log.info("Workspace token: agent account not provisioned", sanitizeForLogging({ ownerEmail, requestId }))
      return NextResponse.json({ status: "account-not-provisioned" }, { status: 404 })
    }
    if (err instanceof InvalidOwnerError) {
      log.warn("Workspace-token invalid owner", sanitizeForLogging({ ownerEmail, requestId, reason: err.message }))
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof BrokerNotConfiguredError) {
      log.error("Workspace-token broker not configured", sanitizeForLogging({ requestId, reason: err.message }))
      return NextResponse.json(
        { error: "Workspace token broker is not configured. Contact IT." },
        { status: 503 }
      )
    }
    log.error("Workspace-token mint failed", sanitizeForLogging({
      ownerEmail,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    }))
    return NextResponse.json(
      { error: "Failed to mint workspace token. Please try again." },
      { status: 502 }
    )
  }
}

/** Test-only: clear the in-memory rate-limit window between tests. */
export function __resetRateLimitForTests(): void {
  _mintWindow.clear()
}
