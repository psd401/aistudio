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
 * Switched GLM-5 -> Claude Sonnet 5 for #1089 (caching-capable harness model)
 * over Bedrock Mantle's Anthropic Messages endpoint. IMPORTANT: the REQUEST id
 * OpenClaw sends (openclaw.json) and the id Mantle RECORDS on the response
 * DIFFER — the request uses the Bedrock form `anthropic.claude-sonnet-5` but the
 * response echoes the bare `claude-sonnet-5` (verified live). So there are two
 * ids: AGENT_REQUEST_MODEL_ID (what we send) and AGENT_MODEL_ID (what we record
 * + price). Migration 092 seeds pricing for all three forms to be safe.
 *
 * This lives outside the `"use server"` action files on purpose — a server
 * action module may only export async functions, so a plain constant export
 * from there would be rejected by Next.js.
 */

/**
 * The model id the wrapper RECORDS on agent_messages.model (and that cost
 * lookups price against). Bedrock Mantle's Anthropic Messages endpoint echoes
 * the response model as the bare `claude-sonnet-5` (verified live), so that —
 * not the request-form `anthropic.claude-sonnet-5` — is what lands on
 * agent_messages.model. Migration 092 seeds pricing for it (+ two aliases).
 */
export const AGENT_MODEL_ID = "claude-sonnet-5"

/**
 * The model id OpenClaw SENDS (the provider model `id` in openclaw.json).
 * The provider talks DIRECTLY to Bedrock Mantle's anthropic-messages
 * endpoint (#1138: the local logging proxy is out of the path; Mantle
 * accepts x-api-key with the bearer token — verified live), and Mantle
 * requires the `anthropic.` foundation-model form on the request. The
 * short-lived us.-profile form from the abandoned bedrock-converse-stream
 * attempt is still priced in migration 092 as an alias.
 */
export const AGENT_REQUEST_MODEL_ID = "anthropic.claude-sonnet-5"

/** Human label for AGENT_MODEL_ID shown in the cost UI. */
export const AGENT_MODEL_LABEL = "Claude Sonnet 5"
