/**
 * Isolated mint Lambda handler (#1232 confused-deputy hardening).
 *
 * This handler is the SOLE principal that performs GCP Workload-Identity-
 * Federation (WIF) + service-account impersonation for the agent workspace
 * integration. It runs in the dedicated `psd-agent-mint-{env}` Lambda under its
 * OWN least-privilege role — the ONLY AWS identity the Google WIF provider
 * trusts. The Next.js frontend NO LONGER holds that trust; it can only
 * `lambda:InvokeFunction` this handler.
 *
 * BLAST-RADIUS INVARIANT (the whole point of this file): every WIF-backed
 * operation here derives the target account as `agnt_<owner-localpart>@domain`
 * SERVER-SIDE (deriveAgentEmail, inside mintAgentWorkspaceToken) or appends the
 * caller's OWN bare username to the OneSync sheet. There is deliberately NO code
 * path that accepts a caller-supplied target `sub`. So even a fully-compromised
 * frontend that can invoke this Lambda at will can only ever obtain a token for
 * an `agnt_` account (agent-generated content) — never a human's mailbox, never
 * an arbitrary `signJwt(sub=...)`. That is the intended codex-P1 residual, and
 * this boundary is what enforces it in infrastructure rather than app code the
 * attacker could bypass.
 *
 * The handler NEVER throws for an expected outcome — it returns a structured
 * result the frontend invoker maps back to the same HTTP responses the routes
 * produced when the broker ran in-process.
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"
import {
  mintAgentWorkspaceToken,
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
} from "@/lib/agent-workspace/dwd-token-broker"
import {
  createSheetsGateway,
  ensureAgentUsernameRow,
  ProvisioningNotConfiguredError,
} from "@/lib/agent-workspace/agent-provisioning-sheet"
import type {
  MintLambdaRequest,
  MintTokenResponse,
  ProvisionAccountResponse,
  MintErrorResponse,
} from "@/lib/agent-workspace/mint-contract"

const log = createLogger({ module: "agent-mint-lambda" })

/** Common error → structured-response mapper (shared by both ops). */
function toErrorResponse(err: unknown): MintErrorResponse {
  if (err instanceof InvalidOwnerError) return { error: err.message, code: "INVALID_OWNER" }
  if (err instanceof BrokerNotConfiguredError) return { error: err.message, code: "BROKER_NOT_CONFIGURED" }
  if (err instanceof ProvisioningNotConfiguredError) return { error: err.message, code: "PROVISIONING_NOT_CONFIGURED" }
  return { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" }
}

/**
 * mint-token: derive `agnt_<owner>` (INSIDE mintAgentWorkspaceToken) and mint a
 * ~1h DWD token for it. AccountNotProvisionedError is an EXPECTED outcome, not an
 * error — it is returned as a distinct status the account-request flow probes on.
 */
async function handleMintToken(ownerEmail: unknown): Promise<MintTokenResponse> {
  if (typeof ownerEmail !== "string" || ownerEmail.length === 0) {
    return { error: "ownerEmail is required", code: "INVALID_OWNER" }
  }
  try {
    const minted = await mintAgentWorkspaceToken(ownerEmail)
    return { accessToken: minted.accessToken, expiresAt: minted.expiresAt, agentEmail: minted.agentEmail }
  } catch (err) {
    if (err instanceof AccountNotProvisionedError) {
      return { status: "account-not-provisioned", agentEmail: err.agentEmail }
    }
    return toErrorResponse(err)
  }
}

/**
 * provision-account: append the caller's OWN bare username to the OneSync sheet
 * (idempotent). No agnt_ derivation needed — the sheet stores the plain username
 * and OneSync creates `agnt_<username>` on its next run.
 */
async function handleProvisionAccount(username: unknown): Promise<ProvisionAccountResponse> {
  if (typeof username !== "string" || username.length === 0) {
    return { error: "username is required", code: "INTERNAL" }
  }
  try {
    const { written } = await ensureAgentUsernameRow(username, createSheetsGateway())
    return { written }
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Pure dispatch — exported for direct unit testing (no AWS Lambda envelope).
 * Returns a structured result for every op; an unknown op is an INTERNAL error.
 */
export async function handleMintEvent(
  event: MintLambdaRequest
): Promise<MintTokenResponse | ProvisionAccountResponse> {
  const op = (event as { op?: unknown } | null | undefined)?.op
  switch (op) {
    case "mint-token":
      return handleMintToken((event as { ownerEmail?: unknown }).ownerEmail)
    case "provision-account":
      return handleProvisionAccount((event as { username?: unknown }).username)
    default:
      return { error: `Unknown mint op: ${String(op)}`, code: "INTERNAL" }
  }
}

/** AWS Lambda entrypoint (bundled to index.handler). */
export async function handler(
  event: MintLambdaRequest
): Promise<MintTokenResponse | ProvisionAccountResponse> {
  const op = (event as { op?: unknown } | null | undefined)?.op
  log.info("mint lambda invoked", sanitizeForLogging({ op }))
  return handleMintEvent(event)
}
