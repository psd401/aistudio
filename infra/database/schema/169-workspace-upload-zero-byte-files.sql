-- ============================================================================
-- 169: allow verified workspace uploads to represent empty files
-- ============================================================================
--
-- Empty regular files are real workspace state. The broker validates their
-- SHA-256 checksum and promotes the exact S3 version just like non-empty
-- files, but migration 153's strictly-positive constraint rejected the
-- reservation row before that workflow could begin.
--
-- Existing rows are already positive, so replacing the check is additive for
-- current data. Keep the lower bound: negative byte counts remain invalid.
-- ============================================================================

ALTER TABLE workspace_upload_reservations
  DROP CONSTRAINT IF EXISTS workspace_upload_reservations_expected_bytes_check;

ALTER TABLE workspace_upload_reservations
  ADD CONSTRAINT workspace_upload_reservations_expected_bytes_check
  CHECK (expected_bytes >= 0);
