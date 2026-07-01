-- Migration 090: Atrium content audit log
-- Part of #1055 (Epic #1059, Atrium Phase 5 — Agent access)
--
-- Every MCP/REST content mutation appends one row here: a complete external
-- creation/publish trail a district will want for FERPA/COPPA/CIPA governance
-- (§27). Append-only: no updated_at, no trigger.
--
-- Deliberately NOT folded into nexus_mcp_audit_logs, whose server_id (FK ->
-- nexus_mcp_servers) and user_id are both NOT NULL — neither fits a REST or
-- autonomous-agent content write (an autonomous agent has no human user, only the
-- configured system user). This table is content-shaped instead.
--
-- object_id is NULLABLE (a create has no id until the row is inserted; a failed
-- create has none at all) and intentionally has NO foreign key, so the audit trail
-- SURVIVES deletion of the content object it records.
--
-- Reuses the existing actor_kind and publish_destination enums (migration 085).
-- ADDITIVE and idempotent (IF NOT EXISTS). No DO $$ blocks — the migration
-- runner's statement splitter cannot handle dollar-quoted blocks (see 085/086/087).

CREATE TABLE IF NOT EXISTS content_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id     uuid,
  action        varchar(40)  NOT NULL,
  surface       varchar(16)  NOT NULL,
  actor_kind    actor_kind   NOT NULL,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  agent_id      uuid REFERENCES agent_identities(id) ON DELETE SET NULL,
  agent_label   text,
  destination   publish_destination,
  outcome       varchar(24)  NOT NULL,
  error         text,
  request_id    varchar(255),
  created_at    timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_audit_object ON content_audit_logs (object_id);
CREATE INDEX IF NOT EXISTS idx_content_audit_created ON content_audit_logs (created_at);
