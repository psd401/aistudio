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

-- Create composite partial index for pending jobs
-- CONCURRENTLY allows creation without blocking writes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_streaming_jobs_pending_created
  ON ai_streaming_jobs (status, created_at)
  WHERE status = 'pending';

-- Verify index was created
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE indexname = 'idx_ai_streaming_jobs_pending_created'
  ) THEN
    RAISE NOTICE 'Index idx_ai_streaming_jobs_pending_created created successfully';
  ELSE
    RAISE EXCEPTION 'Failed to create index idx_ai_streaming_jobs_pending_created';
  END IF;
END $$;
