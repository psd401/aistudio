-- ============================================================================
-- 168 — Allow deletion to cancel in-flight legacy repository items (#1474)
--
-- Repository and item deletion fence pending work by changing
-- repository_items.processing_status to 'cancelled'. Migration 010's CHECK
-- predates that lifecycle state, so pending/processing items currently make the
-- entire deletion transaction roll back. Preserve every existing status and add
-- only the missing cancellation state.
-- ============================================================================

ALTER TABLE repository_items
  DROP CONSTRAINT IF EXISTS repository_items_processing_status_check;

ALTER TABLE repository_items
  ADD CONSTRAINT repository_items_processing_status_check
  CHECK (
    processing_status IN (
      'pending',
      'processing',
      'processing_ocr',
      'processing_embeddings',
      'completed',
      'embedded',
      'failed',
      'embedding_failed',
      'cancelled'
    )
  );

-- Manual rollback (only after removing or reclassifying all 'cancelled' rows):
-- ALTER TABLE repository_items
--   DROP CONSTRAINT IF EXISTS repository_items_processing_status_check;
-- ALTER TABLE repository_items
--   ADD CONSTRAINT repository_items_processing_status_check
--   CHECK (
--     processing_status IN (
--       'pending',
--       'processing',
--       'processing_ocr',
--       'processing_embeddings',
--       'completed',
--       'embedded',
--       'failed',
--       'embedding_failed'
--     )
--   );
