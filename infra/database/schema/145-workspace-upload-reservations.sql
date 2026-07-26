CREATE TABLE IF NOT EXISTS workspace_upload_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key VARCHAR(256) NOT NULL,
  context_key VARCHAR(256) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  public_artifact BOOLEAN NOT NULL,
  staging_key VARCHAR(1024) NOT NULL,
  target_key VARCHAR(1024) NOT NULL,
  expected_bytes BIGINT NOT NULL CHECK (expected_bytes > 0),
  checksum_sha256 VARCHAR(44) NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  byte_lease_id VARCHAR(36) NOT NULL,
  object_lease_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'verifying', 'committed', 'superseded', 'rejected', 'expired')),
  object_version_id VARCHAR(1024),
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspace_upload_idempotency
    UNIQUE (owner_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_upload_owner_status
  ON workspace_upload_reservations(owner_key, public_artifact, status);
CREATE INDEX IF NOT EXISTS idx_workspace_upload_expiry
  ON workspace_upload_reservations(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_upload_target_active
  ON workspace_upload_reservations(owner_key, target_key)
  WHERE status IN ('reserved', 'verifying');

DROP TRIGGER IF EXISTS trg_workspace_upload_reservations_updated_at
  ON workspace_upload_reservations;
CREATE TRIGGER trg_workspace_upload_reservations_updated_at
  BEFORE UPDATE ON workspace_upload_reservations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
