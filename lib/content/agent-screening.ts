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
 * FAIL CLOSED: the shared guardrails service fails OPEN (returns allowed:true
 * with `degraded:true`) when an AWS error/timeout/throttle prevents evaluation —
 * acceptable for latency-sensitive chat, but NOT for unscreened agent content
 * persisted into K-12 documents. A degraded evaluation is treated as blocked
 * here; the agent retries once guardrails recover.
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
/** User-facing message when screening itself is unavailable (fail closed). */
export const AGENT_SCREEN_DEGRADED_MESSAGE =
  "Content could not be safety-screened right now. Please retry shortly.";

/** The outcome of screening one piece of agent-authored content. */
export type AgentScreenVerdict =
  | { allowed: true }
  | { allowed: false; reason: "blocked" | "degraded"; message: string };

/**
 * Screen agent-authored text: block on guardrails, fail closed on a degraded
 * evaluation, log detected PII (telemetry only — never tokenize-replace, a
 * persisted document keeps its real text). Returns a verdict; callers map it to
 * their surface (the bridge to 422/503 responses, the services to a thrown
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
  // FAIL CLOSED on degraded guardrails (see module JSDoc): a transient Bedrock
  // failure must never let hate speech / CSAM / etc. through; reject and let the
  // agent retry.
  if (safety.degraded) {
    log.error("Agent write rejected: guardrails unavailable (failing closed)", {
      objectId,
    });
    return {
      allowed: false,
      reason: "degraded",
      message: AGENT_SCREEN_DEGRADED_MESSAGE,
    };
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
 * Throws a fail-closed `ValidationError` with the same user-facing semantics as
 * the agent-bridge route: blocked content → "Content blocked by safety policy",
 * degraded screening → "Safety screening unavailable" (retryable). Callers MUST
 * invoke this BEFORE their write transaction — screening is external IO
 * (Bedrock) and must never hold a pooled connection.
 */
export async function screenAgentBodyForWrite(
  req: Requester,
  body: string | undefined,
  objectId: string | null,
  requestId?: string
): Promise<void> {
  if (!isAgentRequester(req)) return;
  if (typeof body !== "string" || body.trim().length === 0) return;

  const verdict = await screenAgentContent(body, objectId, requestId);
  if (!verdict.allowed) {
    throw new ValidationError(
      verdict.reason === "blocked"
        ? "Content blocked by safety policy"
        : "Safety screening unavailable",
      { reason: verdict.reason, message: verdict.message, objectId }
    );
  }
}
