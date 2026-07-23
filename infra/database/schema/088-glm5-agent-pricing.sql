-- Migration 088: GLM-5 agent-platform pricing row
-- Part of #1083 (Agent Platform — GLM-5 usage & cost telemetry)
--
-- The admin Agents dashboard computes cost as (tokens × pricing) by joining
-- agent_messages.model against ai_models.model_id. The GLM-5 agents record
-- model = 'zai.glm-5' (see infra/agent-image/openclaw.json + agentcore_wrapper.py),
-- but no ai_models row existed for that id, so every cost calc resolved to $0.
--
-- This adds the row. The model_id MUST be exactly 'zai.glm-5' to match the
-- string the wrapper records — a mismatch silently yields $0 (see
-- docs/guides/ai-model-import-guide.md / silent-failure-patterns.md).
--
-- Pricing (researched 2026-06-30, AWS Bedrock zai.glm-5):
--   Input:  $1.00 / 1M tokens  = 0.001000 / 1k tokens
--   Output: $3.20 / 1M tokens  = 0.003200 / 1k tokens
-- Sources: AWS Bedrock cost calculator + AWS Bedrock pricing page.
--
-- This model is NOT a Nexus/Architect user-facing model — it is the agent
-- platform's harness model only. Flag it inactive for the user-facing pickers
-- (active=false, nexus_enabled=false, architect_enabled=false) so it never
-- appears in chat/architect model selectors, but it remains joinable for cost.
--
-- ADDITIVE and idempotent. No DO $$ blocks (the migration runner's statement
-- splitter cannot handle dollar-quoted blocks — see migration 079).

INSERT INTO ai_models (
  name,
  provider,
  model_id,
  description,
  max_tokens,
  active,
  nexus_enabled,
  architect_enabled,
  input_cost_per_1k_tokens,
  output_cost_per_1k_tokens,
  pricing_updated_at
) VALUES (
  'GLM-5 (Bedrock Mantle)',
  'amazon-bedrock',
  'zai.glm-5',
  'GLM-5 served via Bedrock Mantle — the model powering the AI Studio agent platform (Google Chat agents). Registered for cost attribution only; not exposed in user-facing model pickers.',
  32768,
  false,
  false,
  false,
  0.001000,
  0.003200,
  CURRENT_TIMESTAMP
)
ON CONFLICT (model_id) DO UPDATE SET
  input_cost_per_1k_tokens = EXCLUDED.input_cost_per_1k_tokens,
  output_cost_per_1k_tokens = EXCLUDED.output_cost_per_1k_tokens,
  pricing_updated_at = EXCLUDED.pricing_updated_at,
  description = EXCLUDED.description;
