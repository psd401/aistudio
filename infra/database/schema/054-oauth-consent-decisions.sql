-- =====================================================
-- Migration: 054-oauth-consent-decisions.sql
-- Description: Database-backed OAuth consent decisions
-- Issue: #686
-- Part of: Issue #686 (MCP Server + OAuth2/OIDC Provider Phase 3)
-- Dependencies: users table (002)
--
-- Purpose:
-- Store consent decisions in the database instead of in-memory Map
-- to support multi-container ECS deployments where requests may
-- hit different container instances between consent and callback.
--
-- Rollback:
-- DROP TABLE IF EXISTS oauth_consent_decisions;
-- =====================================================

CREATE TABLE IF NOT EXISTS oauth_consent_decisions (
  uid VARCHAR(255) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved BOOLEAN NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_consent_expires ON oauth_consent_decisions(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_uid_expires ON oauth_consent_decisions(uid, expires_at);
