-- Migration 091: scheduled_executions agent service-identity
-- Part of #1055 (Epic #1059, Atrium Phase 5 — Agent access)
--
-- A scheduled Assistant Architect run is the autonomous production path (§25): it
-- can produce content and publish it internally. Today every scheduled run
-- executes under the OWNING USER's identity. This column lets a schedule run
-- under an `agent_identity` instead — so content the run authors is owned by the
-- system user and stamped created_by_agent_id, and is bounded by the identity's
-- scopes (which never include content:publish_public).
--
-- NULLABLE and additive: a null agent_identity_id preserves the existing
-- user-identity behavior (back-compat). ON DELETE SET NULL so removing an
-- identity reverts its schedules to the user path rather than deleting them.
--
-- Idempotent (IF NOT EXISTS). No DO $$ blocks (splitter compatibility).

ALTER TABLE scheduled_executions
  ADD COLUMN IF NOT EXISTS agent_identity_id uuid
  REFERENCES agent_identities(id) ON DELETE SET NULL;
