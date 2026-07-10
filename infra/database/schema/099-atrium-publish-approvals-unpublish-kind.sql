-- Migration 099: Atrium approval queue — add the 'unpublish' request kind
-- Part of issue #1118 (Epic #1059 hardening follow-ups from PR #1115 review).
--
-- The §26.4 public-destination UNPUBLISH gate (publishService.unpublish) used to
-- raw-throw ApprovalRequiredError without persisting a content_publish_requests
-- row, so a blocked unpublish never appeared in /admin/atrium. It now routes
-- through the shared raisePublishApprovalRequired persistence path as a new
-- 'unpublish' kind (replayed cleanly via publishService.unpublish on approve).
--
-- This migration widens the request_kind CHECK to admit 'unpublish'. The inline
-- CHECK from migration 096 was auto-named content_publish_requests_request_kind_check
-- by Postgres; drop it (IF EXISTS, idempotent) and re-add a NAMED constraint with
-- the extended value set so future migrations can target it by name.
--
-- NO new kind is added for CREATE: an unauthorized public create is no longer
-- blocked — the object is created PRIVATE and a 'visibility_widen' request is
-- queued for it (see content-service.create), which replays cleanly. So the only
-- new kind here is 'unpublish'.
--
-- content_publish_requests is owned by the master migration role (created in 096),
-- so DROP/ADD CONSTRAINT is permitted (unlike ALTER on the postgres-owned early
-- objects — see MEMORY: migration 085). ADDITIVE + idempotent; no DO $$ blocks.

ALTER TABLE content_publish_requests
  DROP CONSTRAINT IF EXISTS content_publish_requests_request_kind_check;

ALTER TABLE content_publish_requests
  DROP CONSTRAINT IF EXISTS chk_cpr_request_kind;

ALTER TABLE content_publish_requests
  ADD CONSTRAINT chk_cpr_request_kind
  CHECK (request_kind IN ('publish', 'visibility_widen', 'unpublish', 'export'));
