-- Migration: 041-add-user-cascade-constraints.sql
-- Description: Add CASCADE DELETE constraints to all tables with foreign keys to users
-- Issue: #556 - User deletion fails due to missing CASCADE constraints on foreign keys
--
-- This migration modifies foreign key constraints to enable proper user deletion.
-- - CASCADE: User-owned content is deleted when user is deleted
-- - SET NULL: Audit/historical records preserve data but clear user reference

-- ============================================================================
-- CASCADE DELETE CONSTRAINTS (22 user-owned tables)
-- ============================================================================

-- user_roles: Role assignments belong to user
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_fkey;
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_users_id_fk;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- tool_edits: User's assistant architect edits
ALTER TABLE tool_edits DROP CONSTRAINT IF EXISTS tool_edits_user_id_fkey;
ALTER TABLE tool_edits DROP CONSTRAINT IF EXISTS tool_edits_user_id_users_id_fk;
ALTER TABLE tool_edits ADD CONSTRAINT tool_edits_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ai_streaming_jobs: User's AI streaming sessions
ALTER TABLE ai_streaming_jobs DROP CONSTRAINT IF EXISTS ai_streaming_jobs_user_id_fkey;
ALTER TABLE ai_streaming_jobs DROP CONSTRAINT IF EXISTS ai_streaming_jobs_user_id_users_id_fk;
ALTER TABLE ai_streaming_jobs ADD CONSTRAINT ai_streaming_jobs_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- prompt_library: User's saved prompts (user_id - owner)
ALTER TABLE prompt_library DROP CONSTRAINT IF EXISTS prompt_library_user_id_fkey;
ALTER TABLE prompt_library DROP CONSTRAINT IF EXISTS prompt_library_user_id_users_id_fk;
ALTER TABLE prompt_library ADD CONSTRAINT prompt_library_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_mcp_connections: User's MCP server connections
ALTER TABLE nexus_mcp_connections DROP CONSTRAINT IF EXISTS nexus_mcp_connections_user_id_fkey;
ALTER TABLE nexus_mcp_connections DROP CONSTRAINT IF EXISTS nexus_mcp_connections_user_id_users_id_fk;
ALTER TABLE nexus_mcp_connections ADD CONSTRAINT nexus_mcp_connections_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- tool_executions: User's assistant runs
ALTER TABLE tool_executions DROP CONSTRAINT IF EXISTS tool_executions_user_id_fkey;
ALTER TABLE tool_executions DROP CONSTRAINT IF EXISTS tool_executions_user_id_users_id_fk;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ideas: User's feature requests
ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_user_id_fkey;
ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_user_id_users_id_fk;
ALTER TABLE ideas ADD CONSTRAINT ideas_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_mcp_audit_logs: User's MCP audit trail
ALTER TABLE nexus_mcp_audit_logs DROP CONSTRAINT IF EXISTS nexus_mcp_audit_logs_user_id_fkey;
ALTER TABLE nexus_mcp_audit_logs DROP CONSTRAINT IF EXISTS nexus_mcp_audit_logs_user_id_users_id_fk;
ALTER TABLE nexus_mcp_audit_logs ADD CONSTRAINT nexus_mcp_audit_logs_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- assistant_architects: User's assistant configurations
ALTER TABLE assistant_architects DROP CONSTRAINT IF EXISTS assistant_architects_user_id_fkey;
ALTER TABLE assistant_architects DROP CONSTRAINT IF EXISTS assistant_architects_user_id_users_id_fk;
ALTER TABLE assistant_architects ADD CONSTRAINT assistant_architects_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- jobs: User's background jobs
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_user_id_fkey;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_user_id_users_id_fk;
ALTER TABLE jobs ADD CONSTRAINT jobs_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_shares: Shares created by user
ALTER TABLE nexus_shares DROP CONSTRAINT IF EXISTS nexus_shares_shared_by_fkey;
ALTER TABLE nexus_shares DROP CONSTRAINT IF EXISTS nexus_shares_shared_by_users_id_fk;
ALTER TABLE nexus_shares ADD CONSTRAINT nexus_shares_shared_by_users_id_fk
  FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE;

-- scheduled_executions: User's scheduled tasks
ALTER TABLE scheduled_executions DROP CONSTRAINT IF EXISTS scheduled_executions_user_id_fkey;
ALTER TABLE scheduled_executions DROP CONSTRAINT IF EXISTS scheduled_executions_user_id_users_id_fk;
ALTER TABLE scheduled_executions ADD CONSTRAINT scheduled_executions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- idea_votes: User's votes
ALTER TABLE idea_votes DROP CONSTRAINT IF EXISTS idea_votes_user_id_fkey;
ALTER TABLE idea_votes DROP CONSTRAINT IF EXISTS idea_votes_user_id_users_id_fk;
ALTER TABLE idea_votes ADD CONSTRAINT idea_votes_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_user_preferences: User's personal settings
ALTER TABLE nexus_user_preferences DROP CONSTRAINT IF EXISTS nexus_user_preferences_user_id_fkey;
ALTER TABLE nexus_user_preferences DROP CONSTRAINT IF EXISTS nexus_user_preferences_user_id_users_id_fk;
ALTER TABLE nexus_user_preferences ADD CONSTRAINT nexus_user_preferences_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- prompt_usage_events: User's prompt usage analytics
ALTER TABLE prompt_usage_events DROP CONSTRAINT IF EXISTS prompt_usage_events_user_id_fkey;
ALTER TABLE prompt_usage_events DROP CONSTRAINT IF EXISTS prompt_usage_events_user_id_users_id_fk;
ALTER TABLE prompt_usage_events ADD CONSTRAINT prompt_usage_events_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- repository_access: User's access grants
ALTER TABLE repository_access DROP CONSTRAINT IF EXISTS repository_access_user_id_fkey;
ALTER TABLE repository_access DROP CONSTRAINT IF EXISTS repository_access_user_id_users_id_fk;
ALTER TABLE repository_access ADD CONSTRAINT repository_access_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- knowledge_repositories: User's knowledge bases
ALTER TABLE knowledge_repositories DROP CONSTRAINT IF EXISTS knowledge_repositories_owner_id_fkey;
ALTER TABLE knowledge_repositories DROP CONSTRAINT IF EXISTS knowledge_repositories_owner_id_users_id_fk;
ALTER TABLE knowledge_repositories ADD CONSTRAINT knowledge_repositories_owner_id_users_id_fk
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_conversations: User's chat history
ALTER TABLE nexus_conversations DROP CONSTRAINT IF EXISTS nexus_conversations_user_id_fkey;
ALTER TABLE nexus_conversations DROP CONSTRAINT IF EXISTS nexus_conversations_user_id_users_id_fk;
ALTER TABLE nexus_conversations ADD CONSTRAINT nexus_conversations_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_templates: User's prompt templates
ALTER TABLE nexus_templates DROP CONSTRAINT IF EXISTS nexus_templates_user_id_fkey;
ALTER TABLE nexus_templates DROP CONSTRAINT IF EXISTS nexus_templates_user_id_users_id_fk;
ALTER TABLE nexus_templates ADD CONSTRAINT nexus_templates_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- nexus_folders: User's folder organization
ALTER TABLE nexus_folders DROP CONSTRAINT IF EXISTS nexus_folders_user_id_fkey;
ALTER TABLE nexus_folders DROP CONSTRAINT IF EXISTS nexus_folders_user_id_users_id_fk;
ALTER TABLE nexus_folders ADD CONSTRAINT nexus_folders_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- idea_notes: User's notes on ideas
ALTER TABLE idea_notes DROP CONSTRAINT IF EXISTS idea_notes_user_id_fkey;
ALTER TABLE idea_notes DROP CONSTRAINT IF EXISTS idea_notes_user_id_users_id_fk;
ALTER TABLE idea_notes ADD CONSTRAINT idea_notes_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- documents: User's uploaded files
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_user_id_users_id_fk;
ALTER TABLE documents ADD CONSTRAINT documents_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- user_notifications: User's notifications
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_user_id_fkey;
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_user_id_users_id_fk;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ============================================================================
-- SET NULL CONSTRAINTS (3 audit/historical references)
-- These preserve historical records but clear user reference on deletion
-- ============================================================================

-- model_comparisons: Preserve comparison data for analytics
ALTER TABLE model_comparisons DROP CONSTRAINT IF EXISTS model_comparisons_user_id_fkey;
ALTER TABLE model_comparisons DROP CONSTRAINT IF EXISTS model_comparisons_user_id_users_id_fk;
ALTER TABLE model_comparisons ADD CONSTRAINT model_comparisons_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- model_replacement_audit: Preserve audit history
ALTER TABLE model_replacement_audit DROP CONSTRAINT IF EXISTS model_replacement_audit_replaced_by_fkey;
ALTER TABLE model_replacement_audit DROP CONSTRAINT IF EXISTS model_replacement_audit_replaced_by_users_id_fk;
ALTER TABLE model_replacement_audit ADD CONSTRAINT model_replacement_audit_replaced_by_users_id_fk
  FOREIGN KEY (replaced_by) REFERENCES users(id) ON DELETE SET NULL;

-- prompt_library.moderated_by: Preserve moderation history
ALTER TABLE prompt_library DROP CONSTRAINT IF EXISTS prompt_library_moderated_by_fkey;
ALTER TABLE prompt_library DROP CONSTRAINT IF EXISTS prompt_library_moderated_by_users_id_fk;
ALTER TABLE prompt_library ADD CONSTRAINT prompt_library_moderated_by_users_id_fk
  FOREIGN KEY (moderated_by) REFERENCES users(id) ON DELETE SET NULL;
