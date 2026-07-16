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
 * CONFUSED-DEPUTY ISOLATION (#1232 hardening): this route is a THIN PROXY. The
 * WIF/signJwt work runs in the dedicated `psd-agent-mint-{env}` Lambda (the sole
 * AWS principal the Google WIF provider trusts), reached here via an IAM-authed
 * `lambda:InvokeFunction` (mintAgentWorkspaceTokenViaBoundary). The Next.js
 * frontend NO LONGER holds the WIF credential, so a frontend RCE/SSRF can at most
 * invoke the mint Lambda — which ALWAYS derives `agnt_<owner>` server-side and
 * can never `signJwt(sub=<arbitrary human>)`. Auth + validation + rate limiting +
 * error→HTTP mapping below are unchanged; only the broker call moved behind the
 * Lambda boundary. (When AGENT_MINT_LAMBDA_NAME is unset — local dev/tests — the
 * boundary runs the broker in-process, where there is no real WIF anyway.)
 *
 * SECURITY / KNOWN LIMITATION (codex review P1, #1232 open item): the caller is
 * authenticated ONLY by the shared internal secret, then `ownerEmail` is trusted
 * from the body. The agent runtime can read that secret, so a prompt-driven
 * agent could request a token for a DIFFERENT owner's `agnt_` account. Post-
 * isolation blast radius: a frontend or secret compromise can obtain tokens for
 * `agnt_` accounts (agent-generated content, never a human's mailbox) — it can
 * NOT reach an arbitrary psd401.net mailbox, because the WIF credential lives
 * only in the mint Lambda's role and the derivation guard runs INSIDE that
 * boundary. Binding the token to a *verified* caller identity (a signed owner
 * assertion injected by the OpenClaw runtime, not a body field) is the documented
 * follow-up in #1232 and requires runtime support that does not exist yet.
 *
 * Part of #1232.
 */

import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { validateInternalSecret } from "@/lib/agent-workspace/internal-auth"
import { mintAgentWorkspaceTokenViaBoundary } from "@/lib/agent-workspace/mint-client"
import {
  checkAgentWorkspaceTokenRateLimit,
  getAgentWorkspaceTokenRateLimit,
} from "@/lib/agent-workspace/token-rate-limit"
import {
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"

const log = createLogger({ module: "agent-workspace-token" })

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

  if (!checkAgentWorkspaceTokenRateLimit(ownerEmail)) {
    const rateLimit = getAgentWorkspaceTokenRateLimit()
    log.warn("Workspace-token rate limit exceeded", sanitizeForLogging({ ownerEmail, requestId }))
    return NextResponse.json(
      { error: `Rate limit exceeded — max ${rateLimit} tokens per hour per user` },
      { status: 429, headers: { "Retry-After": "3600" } }
    )
  }

  try {
    // Delegates to the isolated mint Lambda when AGENT_MINT_LAMBDA_NAME is set
    // (every deployed env); runs the broker in-process only for local dev/tests.
    const { accessToken, expiresAt, agentEmail } = await mintAgentWorkspaceTokenViaBoundary(ownerEmail)
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
