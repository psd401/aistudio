-- Migration 135: recoverable Atrium asset upload initiation reservations.
--
-- Only scoped SHA-256 digests are stored. Existing assets remain valid with
-- both columns NULL; keyed initiations always populate both together.

ALTER TABLE content_assets
  ADD COLUMN IF NOT EXISTS initiation_key_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS initiation_request_hash VARCHAR(64);

ALTER TABLE content_assets
  DROP CONSTRAINT IF EXISTS ck_content_asset_initiation_hashes;

ALTER TABLE content_assets
  ADD CONSTRAINT ck_content_asset_initiation_hashes CHECK (
    (initiation_key_hash IS NULL AND initiation_request_hash IS NULL)
    OR
    (
      initiation_key_hash ~ '^[0-9a-f]{64}$'
      AND initiation_request_hash ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_assets_initiation_key
  ON content_assets (object_id, initiation_key_hash)
  WHERE initiation_key_hash IS NOT NULL;
