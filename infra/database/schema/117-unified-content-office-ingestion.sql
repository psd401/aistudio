-- Migration 117: Canonical Office-document ingestion (Epic #1261, Issue #1264)
--
-- Keeps the in-memory Office normalizers behind an administrator-controlled
-- ceiling distinct from the much larger object-storage limit. Larger sources
-- remain eligible for future asynchronous/specialized processors.

INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  ('CONTENT_MAX_OFFICE_SIZE_MB', '100', 'Maximum DOCX, XLSX, or PPTX size for the canonical in-memory Office processor.', 'Content Platform', false)
ON CONFLICT (key) DO NOTHING;
