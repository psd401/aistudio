-- Migration 119: Canonical audio and video ingestion (Epic #1261, Issue #1264)
--
-- The processing duration remains controlled by CONTENT_MAX_MEDIA_HOURS,
-- seeded in migration 116. Bedrock Data Automation's hard byte limits are
-- applied by the upload contract in addition to the administrator storage cap.

ALTER TABLE repository_items
  DROP CONSTRAINT IF EXISTS repository_items_type_check;

ALTER TABLE repository_items
  ADD CONSTRAINT repository_items_type_check
  CHECK (type IN ('document', 'url', 'text', 'image', 'audio', 'video'));

ALTER TABLE repository_artifacts
  DROP CONSTRAINT IF EXISTS chk_repository_artifact_kind;

ALTER TABLE repository_artifacts
  ADD CONSTRAINT chk_repository_artifact_kind
  CHECK (kind IN ('source', 'canonical_text', 'markdown', 'layout', 'table', 'image', 'thumbnail', 'audio', 'video', 'transcript', 'caption'));
