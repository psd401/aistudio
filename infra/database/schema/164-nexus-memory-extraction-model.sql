-- Migration 164: Nexus memory extraction model setting
--
-- Issue #1409 adds paste-first memory import. Extraction uses the standard
-- provider factory with a settings-driven Bedrock model so operators can tune
-- quality and cost without a deployment. Issue #1410 reuses this setting for
-- automatic extraction.

INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
  'MEMORY_EXTRACTION_MODEL_ID',
  'us.amazon.nova-lite-v1:0',
  'Amazon Bedrock model id used to extract Nexus memory candidates from imports and conversations.',
  'nexus-memory',
  false
)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- ROLLBACK SQL (for manual rollback if needed)
-- ============================================
-- DELETE FROM settings WHERE key = 'MEMORY_EXTRACTION_MODEL_ID';
