-- Migration: Remove deprecated nexus_capabilities JSONB column from ai_models
-- Part of Epic #582 - Complete capability consolidation
-- Issue #594 - Eliminate nexus_capabilities field
--
-- Prerequisites:
--   - All runtime code migrated to use 'capabilities' TEXT/JSON array field
--   - capability-utils.ts provides unified parsing for all capability checks
--   - No active code references nexus_capabilities for reads
--
-- This migration removes the deprecated JSONB column that stored duplicate
-- capability data. The unified 'capabilities' TEXT field is now the single
-- source of truth for model capabilities.
--
-- Dependencies to drop (in order):
--   1. Trigger: validate_ai_models_nexus_capabilities
--   2. Index: idx_ai_models_nexus_capabilities
--
-- Note: Uses IF EXISTS for idempotent operation (safe re-runs)
-- Updated: 2026-01-02 - Added trigger and index drops before column drop

-- Step 1: Drop the trigger that validates nexus_capabilities (required before dropping column)
DROP TRIGGER IF EXISTS validate_ai_models_nexus_capabilities ON ai_models;

-- Step 2: Drop the GIN index on nexus_capabilities (required before dropping column)
DROP INDEX IF EXISTS idx_ai_models_nexus_capabilities;

-- Step 3: Drop the deprecated nexus_capabilities JSONB column
ALTER TABLE ai_models
  DROP COLUMN IF EXISTS nexus_capabilities;

-- Update table comment to document the change
COMMENT ON TABLE ai_models IS 'AI model configurations. Capabilities stored in TEXT array field (Issue #594 consolidated from nexus_capabilities JSONB).';
