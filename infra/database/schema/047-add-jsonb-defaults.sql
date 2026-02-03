-- Migration 047: Add defaults and remove NOT NULL from JSONB fields
-- This fixes Drizzle AWS Data API driver serialization bug where JSONB fields
-- with .notNull() combined with .default() cause parameter binding issues.
--
-- Root cause: Drizzle's AWS Data API driver passes JavaScript object references
-- instead of JSON strings when JSONB fields have BOTH .notNull() and .default().
--
-- Solution: Add .default('{}') and make columns NULLABLE (like nexus_conversations.metadata)
--
-- Related: Issue #599

-- tool_executions.input_data
ALTER TABLE tool_executions
  ALTER COLUMN input_data SET DEFAULT '{}'::jsonb,
  ALTER COLUMN input_data DROP NOT NULL;

-- prompt_results.input_data
ALTER TABLE prompt_results
  ALTER COLUMN input_data SET DEFAULT '{}'::jsonb,
  ALTER COLUMN input_data DROP NOT NULL;

-- execution_results.result_data
ALTER TABLE execution_results
  ALTER COLUMN result_data SET DEFAULT '{}'::jsonb,
  ALTER COLUMN result_data DROP NOT NULL;

-- assistant_architect_events.event_data
ALTER TABLE assistant_architect_events
  ALTER COLUMN event_data SET DEFAULT '{}'::jsonb,
  ALTER COLUMN event_data DROP NOT NULL;

-- scheduled_executions (2 fields)
ALTER TABLE scheduled_executions
  ALTER COLUMN schedule_config SET DEFAULT '{}'::jsonb,
  ALTER COLUMN schedule_config DROP NOT NULL,
  ALTER COLUMN input_data SET DEFAULT '{}'::jsonb,
  ALTER COLUMN input_data DROP NOT NULL;

-- tool_edits.changes
ALTER TABLE tool_edits
  ALTER COLUMN changes SET DEFAULT '{}'::jsonb,
  ALTER COLUMN changes DROP NOT NULL;

-- ai_streaming_jobs.request_data
ALTER TABLE ai_streaming_jobs
  ALTER COLUMN request_data SET DEFAULT '{}'::jsonb,
  ALTER COLUMN request_data DROP NOT NULL;

-- nexus_mcp_capabilities.input_schema
ALTER TABLE nexus_mcp_capabilities
  ALTER COLUMN input_schema SET DEFAULT '{}'::jsonb,
  ALTER COLUMN input_schema DROP NOT NULL;
