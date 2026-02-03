-- =====================================================
-- Migration: 051-user-profile-and-api-keys.sql
-- Description: User profile fields + API key management tables
-- Issue: #684
-- Part of: Epic #674 (External API Platform)
-- Dependencies: users table (002), update_updated_at_column() (017)
--
-- Purpose:
-- 1. Add user profile fields to users table (job_title, department, etc.)
-- 2. Create api_keys table for SHA-256 hashed API key management
-- 3. Create api_key_usage table for per-request analytics
--
-- Rollback:
-- DROP TABLE IF EXISTS api_key_usage;
-- DROP TABLE IF EXISTS api_keys;
-- ALTER TABLE users DROP COLUMN IF EXISTS job_title;
-- ALTER TABLE users DROP COLUMN IF EXISTS department;
-- ALTER TABLE users DROP COLUMN IF EXISTS building;
-- ALTER TABLE users DROP COLUMN IF EXISTS grade_levels;
-- ALTER TABLE users DROP COLUMN IF EXISTS bio;
-- ALTER TABLE users DROP COLUMN IF EXISTS profile;
-- =====================================================

-- =====================================================
-- PART 1: USER PROFILE FIELDS
-- =====================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS building VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS grade_levels TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}'::jsonb;

-- Indexes for user profile fields
CREATE INDEX IF NOT EXISTS idx_users_building ON users(building);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department);
CREATE INDEX IF NOT EXISTS idx_users_grade_levels ON users USING GIN (grade_levels);

-- =====================================================
-- PART 2: API KEYS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(8) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  rate_limit_rpm INTEGER DEFAULT 60,
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- PART 3: API KEY USAGE TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS api_key_usage (
  id BIGSERIAL PRIMARY KEY,
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  status_code INTEGER,
  request_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  response_time_ms INTEGER,
  ip_address VARCHAR(45)
);

-- =====================================================
-- INDEXES - api_keys
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
-- Note: key_hash has UNIQUE constraint (line 49) which already creates an index
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);

-- =====================================================
-- INDEXES - api_key_usage
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_time ON api_key_usage(api_key_id, request_at);

-- =====================================================
-- TRIGGERS
-- Uses shared update_updated_at_column() from migration 017
-- =====================================================

DROP TRIGGER IF EXISTS trg_api_keys_updated_at ON api_keys;
CREATE TRIGGER trg_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
