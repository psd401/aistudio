-- One-time request proofs for model-adjacent agent broker calls.
-- The primary key makes nonce consumption atomic across ECS tasks.
CREATE TABLE IF NOT EXISTS psd_agent_request_nonces (
  nonce VARCHAR(36) PRIMARY KEY,
  invocation_nonce VARCHAR(128) NOT NULL,
  owner_email VARCHAR(320) NOT NULL,
  method VARCHAR(12) NOT NULL,
  route VARCHAR(512) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_psd_agent_request_nonces_expiry
  ON psd_agent_request_nonces (expires_at);

CREATE INDEX IF NOT EXISTS idx_psd_agent_request_nonces_invocation
  ON psd_agent_request_nonces (invocation_nonce, created_at);
