-- Migration 118: Canonical image ingestion (Epic #1261, Issue #1264)
--
-- Image processing remains bounded independently from general object storage.
-- Nova 2 Lite is the default low-cost Bedrock captioner and can be changed by
-- administrators to another allowed Amazon Nova multimodal understanding model.

ALTER TABLE repository_items
  DROP CONSTRAINT IF EXISTS repository_items_type_check;

ALTER TABLE repository_items
  ADD CONSTRAINT repository_items_type_check
  CHECK (type IN ('document', 'url', 'text', 'image'));

INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  ('CONTENT_MAX_IMAGE_SIZE_MB', '50', 'Maximum JPEG, PNG, WebP, GIF, or TIFF size for the canonical image processor.', 'Content Platform', false),
  ('CONTENT_IMAGE_CAPTION_MODEL_ID', 'us.amazon.nova-2-lite-v1:0', 'Amazon Bedrock Nova model used for canonical image descriptions.', 'Content Platform', false)
ON CONFLICT (key) DO NOTHING;
