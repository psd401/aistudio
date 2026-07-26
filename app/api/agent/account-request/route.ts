/**
 * agnt_ Account Provisioning Request
 *
 * POST /api/agent/account-request
 * Auth: short-lived router-signed invocation context
 *
 * Idempotently ensures the caller's agnt_<localpart>@psd401.net Workspace
 * account is either present or queued for creation via the OneSync sheet
 * (#1233). Called deterministically by the agent-router on a user's messages —
 * NOT by any AI decision.
 *
 * Request:  {}
 * Response: { status: "active" }      — the agnt_ account already exists
 *           { status: "requested" }   — a row exists / was written; wait for OneSync
 *           { error }                  — 400 / 401 / 503 / 502
 *
 * Behavior:
 *   1. Validate email + allowed domain, reject numeric-prefix (student), derive agnt_.
 *   2. Existence probe: ask the DWD broker to mint a token for the agnt_ address.
 *      Success -> "active". account-not-provisioned -> continue.
 *   3. Dedupe + append the bare username to the OneSync sheet -> "requested".
 *
 * The endpoint is idempotent — any number of calls for the same user result in
 * at most one sheet row.
 *
 * CONFUSED-DEPUTY ISOLATION (#1232 hardening): this route is a THIN PROXY. Both
 * WIF-backed steps — the existence probe (mint) and the OneSync sheet write —
 * run in the dedicated `psd-agent-mint-{env}` Lambda (the sole AWS principal the
 * Google WIF provider trusts), reached via IAM-authed `lambda:InvokeFunction`.
 * The frontend passes only ownerEmail/username; the `agnt_` derivation happens
 * INSIDE the Lambda, so a frontend compromise can never `signJwt(sub=<human>)`.
 * Auth + validation + student guard + error→HTTP mapping are unchanged. (When
 * AGENT_MINT_LAMBDA_NAME is unset — local dev/tests — the boundary runs the
 * broker/sheet in-process, where there is no real WIF anyway.)
 *
 * Part of #1233.
 */

import { NextRequest, NextResponse } from "next/server"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"
import { ProvisioningNotConfiguredError } from "@/lib/agent-workspace/agent-provisioning-sheet"
import {
  mintAgentWorkspaceTokenViaBoundary,
  provisionAgentAccountViaBoundary,
} from "@/lib/agent-workspace/mint-client"

const log = createLogger({ module: "agent-account-request" })

/** Student IDs are numeric-prefix usernames — never provision them (staff-only). */
function isStudentUsername(localPart: string): boolean {
  return /^\d/.test(localPart)
}

/**
 * Map a broker error (thrown by the mint boundary — Lambda or in-process) to its
 * HTTP response, or null if it isn't one of the broker's typed errors (caller
 * decides). Keeps the instanceof branching in one place.
 */
function mapBrokerError(err: unknown, requestId: string): NextResponse | null {
  if (err instanceof InvalidOwnerError) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
  if (err instanceof BrokerNotConfiguredError) {
    log.error("account-request: broker not configured", sanitizeForLogging({ requestId, reason: err.message }))
    return NextResponse.json({ error: "Provisioning is not configured. Contact IT." }, { status: 503 })
  }
  return null
}

/**
 * Probe the mint boundary for the agnt_ account's existence (the boundary derives
 * agnt_<owner> and domain-guards internally). Returns a TERMINAL response
 * (active / 400 / 503 / 502), or null to signal the caller should proceed to the
 * sheet write (account not provisioned yet).
 */
async function probeAgentAccount(ownerEmail: string, requestId: string): Promise<NextResponse | null> {
  try {
    // The mint boundary derives `agnt_<owner>` and enforces the domain guard
    // INSIDE the mint Lambda (or in-process for local dev); a successful mint
    // proves the account exists. InvalidOwner / not-configured surface as the
    // same typed errors, mapped to 400 / 503 by mapBrokerError below.
    await mintAgentWorkspaceTokenViaBoundary(ownerEmail)
    log.info("account-request: agnt_ account already active", sanitizeForLogging({ ownerEmail, requestId }))
    return NextResponse.json({ status: "active" })
  } catch (err) {
    if (err instanceof AccountNotProvisionedError) {
      return null // proceed to the sheet write
    }
    const mapped = mapBrokerError(err, requestId)
    if (mapped) return mapped
    log.error("account-request: probe failed", sanitizeForLogging({
      ownerEmail,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    }))
    return NextResponse.json({ error: "Provisioning probe failed. Try again." }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  const invocationContext = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner"],
  })
  if (!invocationContext) {
    log.warn("Account-request has no authorized owner context", { requestId })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 }
    )
  }
  for (const field of ["ownerEmail", "userEmail", "userId"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return NextResponse.json(
        { error: "Owner selectors are not accepted" },
        { status: 400 }
      )
    }
  }
  const ownerEmail = invocationContext.ownerEmail

  const localPart = ownerEmail.split("@")[0] ?? ""
  if (isStudentUsername(localPart)) {
    // Defense-in-depth: the router also excludes these before calling, and the
    // sheet's staff_info lookup is a third net. Never reaches the sheet.
    log.warn("account-request refused for numeric-prefix (student) username", sanitizeForLogging({ ownerEmail, requestId }))
    return NextResponse.json({ error: "Student accounts are not provisioned." }, { status: 400 })
  }

  // 1. Domain-guard + existence probe via the broker. A terminal response
  // (active / 400 / 503 / 502) short-circuits; null means "not provisioned yet".
  const probeResult = await probeAgentAccount(ownerEmail, requestId)
  if (probeResult) return probeResult

  // 2. Dedupe + append the bare username to the OneSync sheet (via the mint
  // Lambda boundary, or in-process for local dev/tests).
  try {
    const { written } = await provisionAgentAccountViaBoundary(localPart)
    log.info("account-request: agnt_ account queued via sheet", sanitizeForLogging({ ownerEmail, requestId, written }))
    return NextResponse.json({ status: "requested" })
  } catch (err) {
    if (err instanceof ProvisioningNotConfiguredError) {
      return NextResponse.json({ error: "Provisioning sheet is not configured. Contact IT." }, { status: 503 })
    }
    log.error("account-request: sheet write failed", sanitizeForLogging({
      ownerEmail,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    }))
    return NextResponse.json({ error: "Provisioning sheet write failed. Try again." }, { status: 502 })
  }
}
