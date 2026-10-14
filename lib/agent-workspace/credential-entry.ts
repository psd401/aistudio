/**
 * One-time credential entry (issue #1887).
 *
 * Agents used to ask staff to paste an API key — or, in at least one observed
 * case, a vendor single-sign-on password — into a Google Chat message. The
 * value then lived forever in `agent_message_content.content_text` with no
 * redaction. This module backs the replacement: the agent mints a one-time
 * link, the user types the secret into `/agent-connect-credential`, and the
 * value goes straight to the owner-scoped credential broker.
 *
 * Security properties this module is responsible for:
 *   - the link is bound to one person (the consent JWT's `sub`) and refused
 *     for anybody else, signed in or not;
 *   - the link expires in 15 minutes (enforced by the JWT's `exp`, see
 *     `consentTokenExpiry`);
 *   - the link is single-use — the nonce is claimed with a conditional UPDATE,
 *     so a concurrent double-submit has exactly one winner;
 *   - the secret only ever arrives in a POST body. It is never put in a URL,
 *     never logged, and never returned to the caller.
 *
 * The nonce is claimed BEFORE the secret is written. That ordering is
 * deliberate and the opposite of `/agent-connect-data`: a replayable
 * secret-entry form is a worse outcome than a user having to ask for a second
 * link, so a failed write burns the link and says so.
 */

import { and, eq, isNull } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentWorkspaceConsentNonces } from "@/lib/db/schema/tables/agent-workspace-consent-nonces"
import {
  AgentCredentialBroker,
  AgentCredentialInputError,
  isCredentialStorageConfigured,
} from "@/lib/agent-credentials/broker"
import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { verifyConsentToken } from "@/lib/agent-workspace/consent-token"

const log = createLogger({ module: "agent-credential-entry" })

/** Mirrors the value rules in `AgentCredentialBroker.put`. */
const MIN_VALUE_LENGTH = 8
const MAX_VALUE_LENGTH = 4096
const PLACEHOLDER_RE = /^<[^>]+>$/

/**
 * Why a credential-entry link cannot be used right now. Every branch is
 * rendered by the page; none of them echo the submitted value.
 */
export type CredentialEntryRefusal =
  | { status: "missing-token" }
  | { status: "invalid-token" }
  | { status: "needs-signin"; ownerEmail: string }
  | { status: "wrong-user"; expected: string }
  | { status: "already-used" }

/** Result of checking a link before showing the form. */
export type CredentialEntryInspection =
  | CredentialEntryRefusal
  | { status: "ready"; ownerEmail: string; credentialName: string }

/** Result of submitting a value through a link. */
export type CredentialEntrySubmission =
  | CredentialEntryRefusal
  | { status: "invalid-value"; credentialName: string; reason: string }
  | { status: "not-configured" }
  | { status: "write-failed"; credentialName: string }
  | {
      status: "stored"
      credentialName: string
      action: "created" | "rotated"
    }

interface VerifiedLink {
  ownerEmail: string
  credentialName: string
  nonce: string
}

/**
 * Verify the signed link and the viewer's session together. Returns the link's
 * owner + target slot, or the refusal to render.
 */
async function verifyLink(
  token: string | undefined,
  sessionEmail: string | null | undefined
): Promise<CredentialEntryRefusal | { link: VerifiedLink }> {
  if (!token) return { status: "missing-token" }

  // Covers expiry, tampering, the wrong purpose, an unknown kind, and a
  // credential_entry token with no usable slot name.
  const payload = await verifyConsentToken(token)
  if (!payload) return { status: "invalid-token" }
  if (payload.kind !== "credential_entry" || !payload.cred) {
    return { status: "invalid-token" }
  }

  if (!sessionEmail) {
    return { status: "needs-signin", ownerEmail: payload.sub }
  }
  if (sessionEmail.toLowerCase() !== payload.sub.toLowerCase()) {
    // Deliberately does NOT report who is signed in: the refusal is rendered
    // to whoever opened someone else's link.
    // Both sides go in the log even though the PAGE deliberately shows the
    // viewer only the expected owner: without `actual`, repeated probing of
    // one person's links is untraceable.
    log.warn(
      "Credential-entry link opened by a different user",
      sanitizeForLogging({ expected: payload.sub, actual: sessionEmail })
    )
    return { status: "wrong-user", expected: payload.sub }
  }

  return {
    link: {
      ownerEmail: payload.sub,
      credentialName: payload.cred,
      nonce: payload.nonce,
    },
  }
}

/**
 * Has this nonce already been spent? A row that is missing entirely is treated
 * as invalid rather than used: the signature verified, so the row was either
 * cleaned up or never written, and in both cases no secret can be stored.
 */
async function nonceState(
  nonce: string
): Promise<"open" | "used" | "unknown"> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ consumedAt: psdAgentWorkspaceConsentNonces.consumedAt })
        .from(psdAgentWorkspaceConsentNonces)
        .where(eq(psdAgentWorkspaceConsentNonces.nonce, nonce))
        .limit(1),
    "readCredentialEntryNonce"
  )
  const row = rows[0]
  if (!row) return "unknown"
  return row.consumedAt ? "used" : "open"
}

/**
 * Check a link before rendering the entry form. Read-only: nothing is claimed
 * here, so a user who opens the link twice without submitting still gets a
 * usable form.
 */
export async function inspectCredentialEntry(
  token: string | undefined,
  sessionEmail: string | null | undefined
): Promise<CredentialEntryInspection> {
  const verified = await verifyLink(token, sessionEmail)
  if ("status" in verified) return verified

  const state = await nonceState(verified.link.nonce)
  if (state === "used") return { status: "already-used" }
  if (state === "unknown") return { status: "invalid-token" }

  return {
    status: "ready",
    ownerEmail: verified.link.ownerEmail,
    credentialName: verified.link.credentialName,
  }
}

/**
 * Reject a value the broker would reject anyway, BEFORE the nonce is claimed,
 * so a typo does not cost the user their link.
 */
function valueProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Enter the credential value."
  }
  if (value.trim().length < MIN_VALUE_LENGTH) {
    return `That value is too short — credentials must be at least ${MIN_VALUE_LENGTH} characters.`
  }
  // Bounded on the raw string, matching the broker: it stores what was typed,
  // whitespace included, so that is what has to fit.
  if (value.length > MAX_VALUE_LENGTH) {
    return `That value is too long — the maximum is ${MAX_VALUE_LENGTH} characters.`
  }
  if (PLACEHOLDER_RE.test(value.trim())) {
    return "That looks like a placeholder, not a real credential value."
  }
  return null
}

/**
 * Claim the link and store the submitted secret.
 *
 * `broker` is injectable so tests can exercise the claim/write ordering
 * without AWS. The submitted value never appears in a log line or a return
 * value.
 */
export async function submitCredentialEntry(
  input: {
    token: string | undefined
    sessionEmail: string | null | undefined
    value: unknown
  },
  broker: Pick<AgentCredentialBroker, "put"> = new AgentCredentialBroker()
): Promise<CredentialEntrySubmission> {
  const verified = await verifyLink(input.token, input.sessionEmail)
  if ("status" in verified) return verified
  const { ownerEmail, credentialName, nonce } = verified.link

  const problem = valueProblem(input.value)
  if (problem) {
    return { status: "invalid-value", credentialName, reason: problem }
  }

  // Checked BEFORE the claim. A deployment with no ENVIRONMENT cannot store
  // anything, and claiming first would spend the link on a write that was
  // never going to succeed — then spend the replacement link the same way.
  if (!isCredentialStorageConfigured()) {
    log.error(
      "Credential entry attempted on a deployment with no credential storage environment",
      sanitizeForLogging({ ownerEmail, credentialName })
    )
    return { status: "not-configured" }
  }

  // Single-use claim. The `consumed_at IS NULL` predicate makes this atomic:
  // two concurrent submits of the same link produce exactly one non-empty
  // result, so the losing request cannot also write a secret.
  const claimed = await executeQuery(
    (db) =>
      db
        .update(psdAgentWorkspaceConsentNonces)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(psdAgentWorkspaceConsentNonces.nonce, nonce),
            isNull(psdAgentWorkspaceConsentNonces.consumedAt)
          )
        )
        .returning({ nonce: psdAgentWorkspaceConsentNonces.nonce }),
    "claimCredentialEntryNonce"
  )
  if (claimed.length === 0) {
    // Zero rows means either the link was already spent or its row is gone
    // (the cleanup job referenced on the nonces table can delete an old row
    // mid-flight). Telling someone their unused link was "already used" sends
    // them looking for a theft that never happened, so say which it was.
    return (await nonceState(nonce)) === "used"
      ? { status: "already-used" }
      : { status: "invalid-token" }
  }

  try {
    const { action } = await broker.put(
      ownerEmail,
      credentialName,
      input.value
    )
    log.info(
      "Credential stored through one-time entry link",
      sanitizeForLogging({ ownerEmail, credentialName, action })
    )
    return { status: "stored", credentialName, action }
  } catch (error) {
    // The nonce is already spent, so this link is gone either way. Report the
    // failure plainly and let the user ask the agent for a fresh link.
    log.error(
      "Credential-entry write failed after the link was claimed",
      sanitizeForLogging({
        ownerEmail,
        credentialName,
        error:
          error instanceof AgentCredentialInputError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      })
    )
    return { status: "write-failed", credentialName }
  }
}
