-- Migration 127: Atrium mutation idempotency (#1287)
--
-- Raw keys and request bodies are deliberately absent. Completed response
-- payloads are encrypted by the application and records expire after seven days.

CREATE TABLE IF NOT EXISTS content_idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment VARCHAR(64) NOT NULL,
  principal VARCHAR(128) NOT NULL,
  client VARCHAR(160) NOT NULL,
  method VARCHAR(10) NOT NULL,
  route VARCHAR(512) NOT NULL,
  key_hash VARCHAR(64) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'completed')),
  response_status INTEGER,
  response_headers JSONB,
  response_ciphertext TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_content_idempotency_scope UNIQUE (
    environment, principal, client, method, route, key_hash
  ),
  CONSTRAINT ck_content_idempotency_completed_response CHECK (
    state = 'pending'
    OR (
      response_status IS NOT NULL
      AND response_headers IS NOT NULL
      AND response_ciphertext IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_content_idempotency_expiry
  ON content_idempotency_records (expires_at);
