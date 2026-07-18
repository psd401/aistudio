-- Migration 114: Assistant Architect automatic model routing
--
-- Existing assistants retain their exact per-prompt model behavior through the
-- `legacy` default. New assistants explicitly persist `standard` in the create
-- action, and authors may opt an existing assistant into Standard or an
-- Advanced provider family from the builder.

ALTER TABLE assistant_architects
  ADD COLUMN IF NOT EXISTS model_routing_mode text NOT NULL DEFAULT 'legacy';

ALTER TABLE assistant_architects
  ADD COLUMN IF NOT EXISTS model_routing_family text;

ALTER TABLE assistant_architects
  DROP CONSTRAINT IF EXISTS assistant_architects_model_routing_mode_check;

ALTER TABLE assistant_architects
  ADD CONSTRAINT assistant_architects_model_routing_mode_check
  CHECK (model_routing_mode IN ('legacy', 'standard', 'advanced'));

ALTER TABLE assistant_architects
  DROP CONSTRAINT IF EXISTS assistant_architects_model_routing_family_check;

ALTER TABLE assistant_architects
  ADD CONSTRAINT assistant_architects_model_routing_family_check
  CHECK (
    (model_routing_mode = 'advanced' AND model_routing_family IN ('openai', 'anthropic', 'google'))
    OR (model_routing_mode IN ('legacy', 'standard') AND model_routing_family IS NULL)
  );

COMMENT ON COLUMN assistant_architects.model_routing_mode IS
  'Model selection mode: legacy keeps pinned prompt models; standard routes automatically; advanced routes within a selected provider family.';

COMMENT ON COLUMN assistant_architects.model_routing_family IS
  'Advanced routing family constraint: openai, anthropic, or google. NULL for legacy and standard.';
