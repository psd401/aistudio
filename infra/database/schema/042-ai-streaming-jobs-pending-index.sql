-- Migration 042: Add performance index for pending jobs query
-- Part of PR #561 - Drizzle ORM migration for AI streaming jobs
--
-- Issue: getPendingJobs() query performs sequential scan on ai_streaming_jobs table
-- Impact: Slow queries, lock contention under heavy load with many jobs
-- Solution: Add composite partial index on (status, created_at) for pending jobs only
--
-- This index will:
-- - Speed up pending job queries by 10-100x
-- - Reduce lock contention during FOR UPDATE SKIP LOCKED operations
-- - Keep index size small by only indexing pending jobs
-- - Support efficient FIFO processing (ORDER BY created_at ASC)
--
-- NOTE: CONCURRENTLY removed - incompatible with RDS Data API / Lambda migration system
-- For zero-downtime index creation on large production tables, use direct psql connection
-- The IF NOT EXISTS clause provides idempotency for safe re-runs
--
-- ROLLBACK PROCEDURE (if migration fails):
-- If the index creation fails or needs to be removed:
--   1. Connect to database: psql -h <rds-endpoint> -U <username> -d aistudio
--   2. Check index state:
--      SELECT indexname, indexdef FROM pg_indexes
--      WHERE indexname = 'idx_ai_streaming_jobs_pending_created';
--   3. Drop index if needed:
--      DROP INDEX IF EXISTS idx_ai_streaming_jobs_pending_created;
--   4. Remove from migration_log:
--      DELETE FROM migration_log WHERE description = '042-ai-streaming-jobs-pending-index.sql';
--   5. Re-run migration via CDK deploy

-- Create composite partial index for pending jobs
-- IF NOT EXISTS ensures idempotency (index already created successfully)
CREATE INDEX IF NOT EXISTS idx_ai_streaming_jobs_pending_created
  ON ai_streaming_jobs (status, created_at)
  WHERE status = 'pending';
