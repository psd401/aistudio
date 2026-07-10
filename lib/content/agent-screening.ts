/**
 * Atrium agent content screening (spec §28.3)
 *
 * Epic #1059 completion. The single screening core for agent-authored content:
 * Bedrock Guardrails (blocked content is rejected, never persisted) plus PII
 * detection (logged as telemetry — content is NOT tokenized, since a published
 * document/artifact must keep its real text). Extracted from the agent-bridge
 * route so EVERY agent write path — the collab bridge, `contentService.create`,
 * `versionService.snapshot` — screens through one implementation instead of the
 * bridge alone.
 *
 * FAIL OPEN: guardrails are telemetry-only on this path — they must never block
 * a write on their own unavailability. When an AWS error / timeout / throttle /
 * IAM denial prevents evaluation the shared service returns `degraded:true`;
 * this core ALLOWS the content and logs the skipped evaluation as telemetry,
 * rather than rejecting the write. Only a POSITIVE guardrails detection
 * (`allowed:false`) refuses content. (A prior revision failed CLOSED on
 * `degraded` — that turned an `ApplyGuardrail` AccessDenied into a 100% write
 * outage: every workspace/agent edit rejected with "could not be safety-screened
 * right now". See the guardrail-profile IAM incident.)
 *
 * The safety/PII services are imported LAZILY inside `screenAgentContent` so
 * importing the content services (or the `lib/content` barrel) does not
 * statically pull the Bedrock guardrails stack into every consumer.
 */

import { createLogger } from "@/lib/logger";
import { isAgentRequester } from "./helpers";
import { ValidationError } from "./errors";
import type { Requester } from "./types";

/** User-facing message when guardrails blocked but supplied no message. */
export const AGENT_SCREEN_BLOCKED_MESSAGE = "The proposed content was blocked.";

/**
 * Proof that content passed (or did not require) §28.3 screening before a write.
 * Branded with a MODULE-PRIVATE symbol so it can only be produced by
 * `screenAgentBodyForWrite` in this file — a future caller of the shared write
 * primitive (`snapshotInTx`) cannot fabricate one, which is what makes the
 * screening guard un-bypassable (issue #1118 item 3).
 */
const SCREENED = Symbol("atrium.screeningProof");

export interface ScreeningProof {
  readonly [SCREENED]: true;
  /**
   * The exact body that was screened, or null when screening was not required
   * (a human/non-agent writer, or an empty body). `assertScreened` matches this
   * against the body being written, so a proof for body A cannot wave body B in.
   */
  readonly screenedBody: string | null;
}

/** A proof that screening was NOT required (human/non-agent writer, empty body). */
function screeningNotRequired(): ScreeningProof {
  return { [SCREENED]: true, screenedBody: null };
}

/** The outcome of screening one piece of agent-authored content. */
export type AgentScreenVerdict =
  | { allowed: true }
  | { allowed: false; reason: "blocked"; message: string };

/**
 * Screen agent-authored text: refuse only on a POSITIVE guardrails detection,
 * fail OPEN (allow + log) on a degraded/unavailable evaluation, log detected PII
 * (telemetry only — never tokenize-replace, a
 * persisted document keeps its real text). Returns a verdict; callers map it to
 * their surface (the bridge to a 422 block, the services to a thrown
 * `ValidationError` via `screenAgentBodyForWrite`).
 *
 * `objectId` is a correlation ref for logs/guardrail session scoping; pass null
 * on create paths where no object exists yet. `requestId` (optional) threads the
 * caller's request correlation onto the security-relevant blocked/degraded log
 * lines — callers without one (e.g. `versionService.snapshot`) omit it and get
 * an uncorrelated module logger, exactly as before.
 */
export async function screenAgentContent(
  text: string,
  objectId: string | null,
  requestId?: string
): Promise<AgentScreenVerdict> {
  const log = createLogger({
    module: "atrium-agent-screening",
    ...(requestId ? { requestId } : {}),
  });
  // Lazy import (see module JSDoc): keeps the Bedrock stack out of the static
  // import graph of the content services.
  const { getContentSafetyService, getPIITokenizationService } = await import(
    "@/lib/safety"
  );

  const safety = await getContentSafetyService().checkInputSafety(
    text,
    objectId ?? undefined
  );
  if (!safety.allowed) {
    log.warn("Agent write blocked by guardrails", {
      objectId,
      reason: safety.blockedReason,
      categories: safety.blockedCategories,
    });
    return {
      allowed: false,
      reason: "blocked",
      message: safety.blockedMessage ?? AGENT_SCREEN_BLOCKED_MESSAGE,
    };
  }
  // FAIL OPEN on degraded guardrails (see module JSDoc): guardrails are
  // telemetry-only here and must never block a write on their own unavailability
  // (an ApplyGuardrail AccessDenied / throttle / timeout). Log the skipped
  // guardrails evaluation, then FALL THROUGH to PII detection — the write WILL
  // persist, so it must still get PII telemetry (Comprehend is independent of the
  // degraded Bedrock guardrail); a degraded guardrail must not also suppress the
  // student-data telemetry the clean-pass path provides.
  if (safety.degraded) {
    log.warn("Agent write screening degraded — allowing (fail open)", {
      objectId,
    });
  }
  // PII: detect + log only. A document keeps its real text; never tokenize-replace.
  try {
    const entities = await getPIITokenizationService().detectPII(text);
    if (entities.length > 0) {
      log.warn("PII detected in agent content write", {
        objectId,
        piiCount: entities.length,
      });
    }
  } catch (piiError) {
    log.warn("PII detection failed (non-fatal)", {
      error: piiError instanceof Error ? piiError.message : String(piiError),
    });
  }
  return { allowed: true };
}

/**
 * The §28.3 gate for the content-service write paths (`contentService.create`,
 * `versionService.snapshot`): screens the body ONLY when the requester writes as
 * an AGENT — autonomous OR delegated (`isAgentRequester`) — and a non-empty body
 * is present. Both kinds of body screen as text: a document's markdown AND an
 * artifact's code.
 *
 * NOTE this keys off `isAgentRequester`, NOT `actorKindOf`: a delegated agent
 * records provenance as the human it acts for (`actorKindOf → 'human'`), but it
 * is still a machine generating content, so it MUST be screened. Screening is a
 * property of machine authorship, not provenance attribution — otherwise a
 * delegated-identity caller could write unscreened content through
 * `create`/`snapshot` while the agent-bridge route screens unconditionally.
 *
 * Human authors: zero behavior change — this returns without touching the
 * safety stack (the lazy import never even runs).
 *
 * Throws a `ValidationError` ("Content blocked by safety policy") ONLY on a
 * positive guardrails detection — a degraded/unavailable evaluation fails OPEN
 * (see `screenAgentContent`) and never throws. Callers MUST invoke this BEFORE
 * their write transaction — screening is external IO (Bedrock) and must never
 * hold a pooled connection.
 *
 * Returns a `ScreeningProof` the caller passes into the shared write primitive
 * (`snapshotInTx` via `assertScreened`) as evidence screening ran (issue #1118
 * item 3). The proof captures the exact screened body so it cannot be reused for
 * a different one.
 */
export async function screenAgentBodyForWrite(
  req: Requester,
  body: string | undefined,
  objectId: string | null,
  requestId?: string
): Promise<ScreeningProof> {
  if (!isAgentRequester(req)) return screeningNotRequired();
  if (typeof body !== "string" || body.trim().length === 0) {
    return screeningNotRequired();
  }

  const verdict = await screenAgentContent(body, objectId, requestId);
  if (!verdict.allowed) {
    // Only a positive guardrails detection reaches here (degraded fails open).
    throw new ValidationError("Content blocked by safety policy", {
      reason: verdict.reason,
      message: verdict.message,
      objectId,
    });
  }
  return { [SCREENED]: true, screenedBody: body };
}

/**
 * §28.3 defense-in-depth (issue #1118 item 3): assert INSIDE the shared write
 * primitive (`snapshotInTx`) that agent-authored content was screened before it
 * reaches the DB. Screening is pre-tx external IO (Bedrock) and cannot move
 * inside the transaction, so instead every write path funnels its
 * `ScreeningProof` here. A future `snapshotInTx` caller that skips
 * `screenAgentBodyForWrite` cannot produce a valid proof (the brand is
 * module-private) and fails LOUDLY here, rather than silently writing unscreened
 * agent content.
 *
 * No-op for non-agent writers and empty bodies (screening was never required).
 * For an agent body it requires a genuine proof whose `screenedBody` is the EXACT
 * body being written — a stale or mismatched proof throws `ValidationError`.
 */
export function assertScreened(
  req: Requester,
  body: string | undefined,
  proof: ScreeningProof,
  objectId: string | null
): void {
  if (!isAgentRequester(req)) return;
  if (typeof body !== "string" || body.trim().length === 0) return;
  if (proof?.[SCREENED] !== true || proof.screenedBody !== body) {
    throw new ValidationError(
      "Agent content reached the write primitive without screening",
      { objectId }
    );
  }
}
