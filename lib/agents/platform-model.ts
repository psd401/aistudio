/**
 * Agent platform model identity — single source of truth (issue #1083).
 *
 * The Google-Chat agent platform runs on exactly one model today. Its id is
 * recorded on `agent_messages.model` by the wrapper (see
 * infra/agent-image/openclaw.json + agentcore_wrapper.py) and priced by the
 * `ai_models` row in migration 088. Several places need this id/label (the
 * cost-projection self-exclusion filter, the cost UI's "Actual" label); this
 * module keeps them from drifting. If a second agent model is ever added, turn
 * AGENT_MODEL_ID into a set and update the consumers.
 *
 * This lives outside the `"use server"` action files on purpose — a server
 * action module may only export async functions, so a plain constant export
 * from there would be rejected by Next.js.
 */

/** The model id the wrapper records on agent_messages.model. */
export const AGENT_MODEL_ID = "zai.glm-5"

/** Human label for AGENT_MODEL_ID shown in the cost UI. */
export const AGENT_MODEL_LABEL = "GLM-5"
