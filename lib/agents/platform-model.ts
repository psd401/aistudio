/**
 * Agent platform model identity — single source of truth (issue #1083, #1089).
 *
 * The Google-Chat agent platform runs on exactly one model today. Its id is
 * recorded on `agent_messages.model` by the wrapper (see
 * infra/agent-image/openclaw.json + agentcore_wrapper.py) and priced by the
 * `ai_models` row in migration 092. Several places need this id/label (the
 * cost-projection self-exclusion filter, the cost UI's "Actual" label); this
 * module keeps them from drifting. If a second agent model is ever added, turn
 * AGENT_MODEL_ID into a set and update the consumers.
 *
 * Switched GLM-5 -> Claude Sonnet 5 for #1089 (caching-capable harness model).
 * Historically the REQUEST id OpenClaw sent and the id RECORDED on the response
 * DIFFERED — Bedrock Mantle's Anthropic Messages endpoint echoed the bare
 * `claude-sonnet-5` for a request of `anthropic.claude-sonnet-5` — so this
 * module carries two constants. Since #1227 moved the provider onto
 * bedrock-runtime's native endpoint, which echoes the request's
 * inference-profile id verbatim, the two happen to be EQUAL again. They are
 * kept separate anyway: they are distinct concepts, and the next provider swap
 * can split them apart once more. Migration 092 seeds pricing for all three
 * forms to be safe.
 *
 * This lives outside the `"use server"` action files on purpose — a server
 * action module may only export async functions, so a plain constant export
 * from there would be rejected by Next.js.
 */

/**
 * The model id the wrapper RECORDS on agent_messages.model (and that cost
 * lookups price against).
 *
 * As of #1227 the provider talks directly to bedrock-runtime's native
 * anthropic-messages endpoint, which echoes the request's `us.` inference-profile
 * id verbatim — so `us.anthropic.claude-sonnet-5` is what lands on
 * agent_messages.model. VERIFIED against the dev database 2026-08-10: every
 * agent_messages row created on/after 2026-07-31 carries this id, and the prior
 * bare `claude-sonnet-5` appears only up to 2026-07-29.
 *
 * Getting this wrong does NOT fail loudly — the rows simply stop joining
 * ai_models and the cost UI silently reads $0 (bug #1083). Migration 092 seeds
 * pricing for this id and both aliases.
 */
export const AGENT_MODEL_ID = "us.anthropic.claude-sonnet-5"

/**
 * Every id form the harness model has EVER been recorded under, including
 * historical ones still present in `agent_messages` and priced by migration 092.
 *
 * Used to exclude the harness model from the cost-projection candidate list:
 * projecting the harness model onto itself is meaningless, and excluding only
 * the current id would let a re-activated historical alias slip back in.
 */
export const AGENT_MODEL_ID_ALIASES: readonly string[] = [
  "us.anthropic.claude-sonnet-5",
  "anthropic.claude-sonnet-5",
  "claude-sonnet-5",
]

/**
 * The model id OpenClaw SENDS (the provider model `id` in openclaw.json).
 * As of 2026-07-14 (#1227, Mantle serving-plane outage workaround) the
 * provider talks DIRECTLY to bedrock-runtime's native anthropic-messages
 * endpoint instead of Bedrock Mantle's, and that endpoint requires the
 * `us.` inference-profile foundation-model form on the request. The prior
 * bare `anthropic.claude-sonnet-5` (Mantle) form is still priced in
 * migration 092 as an alias — revert this constant alongside openclaw.json
 * if/when Mantle serves sonnet-5 again.
 *
 * Currently equal to AGENT_MODEL_ID because that endpoint echoes the request id
 * verbatim; see the AGENT_MODEL_ID doc comment.
 */
export const AGENT_REQUEST_MODEL_ID = "us.anthropic.claude-sonnet-5"

/** Human label for AGENT_MODEL_ID shown in the cost UI. */
export const AGENT_MODEL_LABEL = "Claude Sonnet 5"
