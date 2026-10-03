-- Migration 186: Claude Sonnet 5.5 pricing for the agent-platform harness model
--
-- The agent image's openclaw.json now selects `us.anthropic.claude-sonnet-5-5`
-- (Bedrock cross-region inference profile). bedrock-runtime's native endpoint
-- echoes the request id verbatim, so that is the id the wrapper records on
-- agent_messages.model. Without a matching ai_models row every agent turn
-- silently prices at $0 (bug #1083), so seed it here.
--
-- Pricing mirrors the Sonnet 5 rows in migration 092 (same Bedrock planning
-- rates): Anthropic prices Sonnet 5.5 identically to Sonnet 5.
--   Input:       $3.00 / 1M tokens = 0.003000 / 1k
--   Output:      $15.00 / 1M tokens = 0.015000 / 1k
--   Cache read:  $0.30 / 1M        = 0.000300 / 1k
--   Cache write: $6.00 / 1M (1h)   = 0.006000 / 1k
--
-- Two id forms are seeded: the recorded/request `us.` profile id, and the bare
-- `anthropic.` foundation-model id as a defensive alias (same reasoning as 092).
--
-- Harness-only rows: active=false, nexus_enabled=false, architect_enabled=false.
-- If an admin has ALREADY registered either id as a user-facing model, the
-- conflict branch only fills pricing columns that are still NULL -- it never
-- touches that row's flags, name, description, or admin-set prices.
--
-- ADDITIVE and idempotent. No DO $$ blocks (see migration 079).

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
  cached_input_cost_per_1k_tokens,
  cache_write_cost_per_1k_tokens,
  pricing_updated_at
) VALUES (
  'Claude Sonnet 5.5 (Bedrock, US inference profile)',
  'amazon-bedrock',
  'us.anthropic.claude-sonnet-5-5',
  'Claude Sonnet 5.5 via the Bedrock US cross-region inference profile -- the AI Studio agent platform (Google Chat agents) harness model. Registered for cost attribution only; not exposed in user-facing model pickers.',
  32768,
  false,
  false,
  false,
  0.003000,
  0.015000,
  0.000300,
  0.006000,
  CURRENT_TIMESTAMP
)
ON CONFLICT (model_id) DO UPDATE SET
  input_cost_per_1k_tokens = COALESCE(ai_models.input_cost_per_1k_tokens, EXCLUDED.input_cost_per_1k_tokens),
  output_cost_per_1k_tokens = COALESCE(ai_models.output_cost_per_1k_tokens, EXCLUDED.output_cost_per_1k_tokens),
  cached_input_cost_per_1k_tokens = COALESCE(ai_models.cached_input_cost_per_1k_tokens, EXCLUDED.cached_input_cost_per_1k_tokens),
  cache_write_cost_per_1k_tokens = COALESCE(ai_models.cache_write_cost_per_1k_tokens, EXCLUDED.cache_write_cost_per_1k_tokens);

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
  cached_input_cost_per_1k_tokens,
  cache_write_cost_per_1k_tokens,
  pricing_updated_at
) VALUES (
  'Claude Sonnet 5.5 (Bedrock)',
  'amazon-bedrock',
  'anthropic.claude-sonnet-5-5',
  'Claude Sonnet 5.5 on Bedrock, bare foundation-model id -- cost-attribution alias for us.anthropic.claude-sonnet-5-5. Not exposed in user-facing model pickers.',
  32768,
  false,
  false,
  false,
  0.003000,
  0.015000,
  0.000300,
  0.006000,
  CURRENT_TIMESTAMP
)
ON CONFLICT (model_id) DO UPDATE SET
  input_cost_per_1k_tokens = COALESCE(ai_models.input_cost_per_1k_tokens, EXCLUDED.input_cost_per_1k_tokens),
  output_cost_per_1k_tokens = COALESCE(ai_models.output_cost_per_1k_tokens, EXCLUDED.output_cost_per_1k_tokens),
  cached_input_cost_per_1k_tokens = COALESCE(ai_models.cached_input_cost_per_1k_tokens, EXCLUDED.cached_input_cost_per_1k_tokens),
  cache_write_cost_per_1k_tokens = COALESCE(ai_models.cache_write_cost_per_1k_tokens, EXCLUDED.cache_write_cost_per_1k_tokens);
