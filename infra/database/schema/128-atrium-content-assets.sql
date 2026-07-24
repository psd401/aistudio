-- Migration 128: immutable authored Atrium image assets (#1284)

CREATE TABLE IF NOT EXISTS content_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
  uploader_actor actor_kind NOT NULL,
  uploader_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploader_agent_id UUID REFERENCES agent_identities(id) ON DELETE SET NULL,
  filename VARCHAR(255) NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  upload_key TEXT NOT NULL UNIQUE,
  content_type VARCHAR(32) NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  sha256 VARCHAR(43) NOT NULL,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('capture_step', 'document_image')),
  state VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'quarantined', 'ready', 'rejected', 'deleted')),
  inspection JSONB,
  upload_expires_at TIMESTAMPTZ NOT NULL,
  ready_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_content_asset_actor CHECK (
    (uploader_actor = 'human' AND uploader_user_id IS NOT NULL AND uploader_agent_id IS NULL)
    OR (uploader_actor = 'agent' AND uploader_user_id IS NULL AND uploader_agent_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_content_assets_object_created
  ON content_assets (object_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_assets_pending_expiry
  ON content_assets (state, upload_expires_at);

CREATE TABLE IF NOT EXISTS content_version_assets (
  version_id UUID NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  CONSTRAINT pk_content_version_assets PRIMARY KEY (version_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_content_version_assets_asset
  ON content_version_assets (asset_id);
