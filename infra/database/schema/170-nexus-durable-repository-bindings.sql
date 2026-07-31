-- Durable repository context for Nexus conversations.
--
-- This table is intentionally separate from nexus_repository_bindings. The
-- existing table owns ephemeral upload lifecycle and cleanup; these rows bind
-- durable repositories selected directly or inherited from a project, skill,
-- or Assistant execution.

ALTER TABLE nexus_conversations
  ADD COLUMN IF NOT EXISTS skill_id UUID
    REFERENCES psd_agent_skills(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_nexus_conversations_skill_id
  ON nexus_conversations (skill_id)
  WHERE skill_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nexus_conversation_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL
    REFERENCES nexus_conversations(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL
    REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  source VARCHAR(16) NOT NULL,
  source_id VARCHAR(255) NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_nexus_conversation_repository_source
    CHECK (source IN ('direct', 'project', 'skill', 'assistant')),
  CONSTRAINT uq_nexus_conversation_repository_source
    UNIQUE (conversation_id, repository_id, source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_nexus_conversation_repositories_conversation
  ON nexus_conversation_repositories (conversation_id, repository_id);

CREATE INDEX IF NOT EXISTS idx_nexus_conversation_repositories_repository
  ON nexus_conversation_repositories (repository_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_nexus_conversation_repositories_creator
  ON nexus_conversation_repositories (created_by, created_at DESC);
