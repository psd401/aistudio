-- Migration 074: Mark Gemini Deep Research model with the deep_research capability.
--
-- The model row for `deep-research-preview-04-2026` (id=127, provider=google) was
-- inserted with capabilities `["chat","web_search","reasoning","thinking","streaming"]`.
-- That row routes through `@ai-sdk/google` → `generateContent` and fails with
-- "This model only supports Interactions API." Deep Research is an *agent* that
-- runs through Google's separate Interactions API with a polling lifecycle, not
-- a streaming token endpoint.
--
-- This migration:
--   * adds `deep_research` so the chat route's capability check branches to the
--     new `runDeepResearch` service instead of the unified streaming path
--   * removes `streaming` (Deep Research returns a single completed report — the
--     UI long-polls; advertising "streaming" misleads consumers of capabilities)
--   * removes `web_search` (web search is implicit in Deep Research and a separate
--     badge would imply a user-toggleable tool, which it is not)
--
-- Other Gemini rows (gemini-3-flash-preview, gemini-3.1-pro-preview,
-- gemini-3.1-flash-image-preview) are intentionally untouched.

UPDATE migration_log SET status = 'completed'
WHERE description = '074-deep-research-capability.sql' AND status = 'failed';

UPDATE ai_models
SET capabilities = '["chat","reasoning","thinking","deep_research"]'
WHERE provider = 'google'
  AND model_id = 'deep-research-preview-04-2026';
