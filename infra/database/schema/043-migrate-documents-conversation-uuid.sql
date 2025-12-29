-- Migration: 043-migrate-documents-conversation-uuid.sql
-- Description: Convert documents.conversation_id from INTEGER to UUID
--              and add foreign key to nexus_conversations
-- Issue: #549 - Migrate documents.conversation_id to UUID with FK to nexus_conversations
-- Part of Epic #526 - RDS Data API to Drizzle ORM Migration
--
-- SAFETY: All 13 existing documents have conversation_id = NULL
-- This ensures safe type conversion with no data loss
--
-- NOTE: DO $$ blocks with RAISE NOTICE removed - incompatible with RDS Data API
-- Pre/post checks moved to manual verification queries in issue comments

-- Step 1: Change column type from INTEGER to UUID
-- This is safe because all existing values are NULL
-- NULL values are preserved across type changes
ALTER TABLE documents
  ALTER COLUMN conversation_id TYPE uuid USING NULL::uuid;

-- Step 2: Add foreign key constraint to nexus_conversations
-- ON DELETE SET NULL: If conversation is deleted, document.conversation_id becomes NULL
ALTER TABLE documents
  ADD CONSTRAINT documents_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES nexus_conversations(id) ON DELETE SET NULL;

-- Step 3: Create filtered index for conversation-based queries
-- Only indexes non-NULL values for efficiency
CREATE INDEX IF NOT EXISTS idx_documents_conversation_id
  ON documents(conversation_id) WHERE conversation_id IS NOT NULL;

-- VERIFICATION QUERIES (run manually after migration):
-- Check column type:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'documents' AND column_name = 'conversation_id';
-- Check FK constraint:
--   SELECT constraint_name FROM information_schema.table_constraints
--   WHERE table_name = 'documents' AND constraint_type = 'FOREIGN KEY';
-- Check data preservation:
--   SELECT COUNT(*) FROM documents; -- Should be >= 13

-- ROLLBACK (via direct psql if needed):
--   ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_conversation_id_fkey;
--   DROP INDEX IF EXISTS idx_documents_conversation_id;
--   ALTER TABLE documents ALTER COLUMN conversation_id TYPE integer USING NULL::integer;
