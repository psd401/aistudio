-- ============================================================================
-- 169 — Explicit agentic model admission metadata
--
-- `ai_models.max_tokens` has historically represented different limits for
-- different providers. Agentic execution must reserve cost from an
-- authoritative context window and output ceiling, so it may not infer either
-- value from that legacy column.
-- ============================================================================

ALTER TABLE ai_models
  ADD COLUMN IF NOT EXISTS context_window_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS max_output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS agentic_ready BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ai_models
  DROP CONSTRAINT IF EXISTS ai_models_context_window_tokens_check,
  ADD CONSTRAINT ai_models_context_window_tokens_check
    CHECK (context_window_tokens IS NULL OR context_window_tokens > 0),
  DROP CONSTRAINT IF EXISTS ai_models_max_output_tokens_check,
  ADD CONSTRAINT ai_models_max_output_tokens_check
    CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  DROP CONSTRAINT IF EXISTS ai_models_agentic_ready_check,
  ADD CONSTRAINT ai_models_agentic_ready_check
    CHECK (
      agentic_ready = FALSE
      OR (
        active = TRUE
        AND architect_enabled = TRUE
        AND context_window_tokens IS NOT NULL
        AND max_output_tokens IS NOT NULL
        AND max_output_tokens <= context_window_tokens
        AND input_cost_per_1k_tokens IS NOT NULL
        AND input_cost_per_1k_tokens >= 0
        AND output_cost_per_1k_tokens IS NOT NULL
        AND output_cost_per_1k_tokens >= 0
      )
    );

-- A trusted context value may be migrated from provider metadata. Do not infer
-- the output limit from legacy max_tokens: existing rows use that field for
-- both context and output semantics depending on provider.
UPDATE ai_models
SET context_window_tokens =
  CASE
    WHEN jsonb_typeof(provider_metadata -> 'max_context_length') = 'number'
      AND (provider_metadata ->> 'max_context_length')::NUMERIC > 0
      AND (provider_metadata ->> 'max_context_length')::NUMERIC <= 2147483647
      THEN (provider_metadata ->> 'max_context_length')::INTEGER
    ELSE context_window_tokens
  END,
  max_output_tokens =
  CASE
    WHEN jsonb_typeof(provider_metadata -> 'max_output_tokens') = 'number'
      AND (provider_metadata ->> 'max_output_tokens')::NUMERIC > 0
      AND (provider_metadata ->> 'max_output_tokens')::NUMERIC <= 2147483647
      THEN (provider_metadata ->> 'max_output_tokens')::INTEGER
    ELSE max_output_tokens
  END
WHERE provider_metadata IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_models_agentic_ready
  ON ai_models(provider, id)
  WHERE active = TRUE
    AND architect_enabled = TRUE
    AND agentic_ready = TRUE;
