-- Migration 126: owner-scoped Atrium Capture provenance correlation (#1290)
--
-- `content_objects.source_ref` is already JSONB. This partial expression index
-- makes a capture session durable and unique within one owner/provider without
-- exposing or globally constraining the external id. Existing upload/object/chat/
-- okf/none rows are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_capture_source
  ON content_objects (
    owner_user_id,
    (source_ref->>'provider'),
    (source_ref->>'externalId')
  )
  WHERE source_ref->>'type' = 'capture';
