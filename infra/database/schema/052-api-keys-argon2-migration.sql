-- =====================================================
-- Migration: 052-api-keys-argon2-migration.sql
-- Description: Widen key_hash for Argon2id hashes, add composite index
-- Issue: #676
-- Part of: Epic #674 (External API Platform)
-- Dependencies: 051-user-profile-and-api-keys.sql
--
-- Purpose:
-- 1. Widen key_hash from VARCHAR(64) to VARCHAR(128) for Argon2id hashes
--    Argon2id encoded hashes are ~97 chars ($argon2id$v=19$m=...$...$....)
-- 2. Drop UNIQUE constraint on key_hash (Argon2 uses random salts, so
--    lookup is now by key_prefix + argon2.verify(), not by hash equality)
-- 3. Add composite index on (user_id, is_active) for quota enforcement
--
-- Rollback:
-- DROP INDEX IF EXISTS idx_api_keys_user_id_is_active;
-- ALTER TABLE api_keys ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash);
-- ALTER TABLE api_keys ALTER COLUMN key_hash TYPE VARCHAR(64);
-- =====================================================

-- Widen key_hash column for Argon2id encoded hashes (~97 chars)
ALTER TABLE api_keys ALTER COLUMN key_hash TYPE VARCHAR(128);

-- Drop the UNIQUE constraint on key_hash
-- Argon2 produces different hashes for the same input (random salt),
-- so uniqueness on hash is meaningless. We rely on key_prefix + argon2.verify().
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_key_hash_key;

-- Add composite index for efficient quota queries (count active keys per user)
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id_is_active ON api_keys(user_id, is_active);
