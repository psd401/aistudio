-- Migration 092: Agent-platform cache-token telemetry + Claude Sonnet 5 pricing
-- Part of #1089 (Migrate agent harness GLM-5 -> Claude Sonnet 5 + Bedrock prompt caching)
--
-- Two additive concerns, both required to price a caching-capable harness model:
--
--   1. agent_messages gains cache_read_input_tokens + cache_write_input_tokens
--      so a per-turn cache split is recorded alongside the existing
--      input_tokens/output_tokens (captured by mantle_proxy.py's /usage delta
--      and threaded through agentcore_wrapper.py -> agent-router).
--
--   2. ai_models gains cache_write_cost_per_1k_tokens (the CACHE-WRITE rate).
--      The cache-READ rate column (cached_input_cost_per_1k_tokens) already
--      exists (migration 029). Both are needed to compute cache-aware cost:
--        cost = input*input_rate + output*output_rate
--             + cache_read*cached_input_rate + cache_write*cache_write_rate
--
-- Then it seeds pricing for Claude Sonnet 5, the new harness model. The model_id
-- MUST exactly match the string the wrapper records on agent_messages.model or
-- every cost calc silently resolves to $0 (see migration 088 / silent-failure-
-- patterns.md). openclaw.json sends `anthropic.claude-sonnet-5`; Bedrock Mantle
-- may echo the region inference-profile form `us.anthropic.claude-sonnet-5`
-- instead, so we seed BOTH ids with identical pricing to eliminate the mismatch
-- risk regardless of which the proxy observes.
--
-- Pricing (Standard AWS Bedrock Claude Sonnet 5, per #1089 planning assumption):
--   Input:       $3.00 / 1M tokens = 0.003000 / 1k
--   Output:      $15.00 / 1M tokens = 0.015000 / 1k
--   Cache read:  0.1x input = $0.30 / 1M = 0.000300 / 1k
--   Cache write: 2x input (1-hour TTL) = $6.00 / 1M = 0.006000 / 1k
-- (The first-party intro rate $2/$10 is treated as upside only; Bedrock does
--  not honor first-party promos.)
--
-- Like GLM-5 (migration 088), Sonnet 5 here is the agent-platform HARNESS model
-- only, not a user-facing Nexus/Architect model: active=false, nexus_enabled=
-- false, architect_enabled=false so it never appears in chat/architect pickers
-- (and is excluded from the cost-projection candidate list) but stays joinable
-- for cost attribution.
--
-- ADDITIVE and idempotent. No DO $$ blocks (the migration runner's statement
-- splitter cannot handle dollar-quoted blocks -- see migration 079).

-- 1. Cache-token columns on agent_messages (migration-role-owned table 065).
ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS cache_write_input_tokens INTEGER NOT NULL DEFAULT 0;

-- 2. Cache-WRITE pricing column on ai_models (read column already exists: 029).
ALTER TABLE ai_models
  ADD COLUMN IF NOT EXISTS cache_write_cost_per_1k_tokens DECIMAL(10, 6) DEFAULT NULL;

-- 3a. Sonnet 5 pricing keyed by the request model id (openclaw.json).
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
  'Claude Sonnet 5 (Bedrock Mantle)',
  'amazon-bedrock',
  'anthropic.claude-sonnet-5',
  'Claude Sonnet 5 served via Bedrock Mantle -- the caching-capable model powering the AI Studio agent platform (Google Chat agents) as of #1089. Registered for cost attribution only; not exposed in user-facing model pickers.',
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
  input_cost_per_1k_tokens = EXCLUDED.input_cost_per_1k_tokens,
  output_cost_per_1k_tokens = EXCLUDED.output_cost_per_1k_tokens,
  cached_input_cost_per_1k_tokens = EXCLUDED.cached_input_cost_per_1k_tokens,
  cache_write_cost_per_1k_tokens = EXCLUDED.cache_write_cost_per_1k_tokens,
  pricing_updated_at = EXCLUDED.pricing_updated_at,
  description = EXCLUDED.description;

-- 3b. Same pricing keyed by the region inference-profile id, in case Mantle
--     echoes `us.anthropic.claude-sonnet-5` on the response `model` field.
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
  'Claude Sonnet 5 (Bedrock Mantle, US inference profile)',
  'amazon-bedrock',
  'us.anthropic.claude-sonnet-5',
  'Claude Sonnet 5 via Bedrock Mantle, region inference-profile id -- cost-attribution alias for anthropic.claude-sonnet-5 in case the proxy records the profile-form model id. Not exposed in user-facing model pickers.',
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
  input_cost_per_1k_tokens = EXCLUDED.input_cost_per_1k_tokens,
  output_cost_per_1k_tokens = EXCLUDED.output_cost_per_1k_tokens,
  cached_input_cost_per_1k_tokens = EXCLUDED.cached_input_cost_per_1k_tokens,
  cache_write_cost_per_1k_tokens = EXCLUDED.cache_write_cost_per_1k_tokens,
  pricing_updated_at = EXCLUDED.pricing_updated_at,
  description = EXCLUDED.description;
