-- Migration 094: Atrium Phase 6 — assistant retrieval scope
-- Issue #1056 (Epic #1059). Adds a JSONB column so an Assistant Architect
-- assistant can store a retrieval scope (collectionId/tags/maxVisibilityLevel)
-- that narrows retrievalService.search candidates before visibilityService.canView
-- is enforced per requester (spec §16.4).

ALTER TABLE assistant_architects
  ADD COLUMN IF NOT EXISTS retrieval_scope jsonb;

COMMENT ON COLUMN assistant_architects.retrieval_scope IS
  'Atrium Phase 6 retrieval scope: {collectionId?, tags?, maxVisibilityLevel?}. Narrows retrievalService.search candidates; canView is still enforced per requester.';
