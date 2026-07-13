-- Migration 105: Atrium content-audit `details` column
-- Part of "Atrium hard delete" (Epic #1059 follow-up). Adds a nullable JSONB
-- `details` column to content_audit_logs so the append-only governance trail can
-- capture STRUCTURED, action-specific context.
--
-- The immediate driver is hard delete: content_audit_logs.object_id has NO FK (by
-- design — the trail must survive object deletion), but after a hard delete that
-- object_id is a DANGLING UUID with no row to join for the title/kind/owner. The
-- delete audit row therefore records the removed object's identity here
-- (`{ title, kind, ownerUserId, versionsDeleted }`), captured inside the delete
-- transaction BEFORE the object row disappears — the only durable record of WHAT
-- was removed. Other actions may populate it later; today only `delete` writes it.
--
-- ADDITIVE, nullable, and idempotent (IF NOT EXISTS). No PL/pgSQL DO $$ blocks
-- (the migration runner's statement splitter cannot handle dollar-quoted blocks —
-- see 085/086/090/097/104). ALTER TABLE ... ADD COLUMN on content_audit_logs is
-- fine under the master migration role: the table is created by migration 090
-- (not one of the postgres-owned 001-005), so the 42501 privilege restriction that
-- blocks ALTER on early objects does not apply here.

ALTER TABLE content_audit_logs
  ADD COLUMN IF NOT EXISTS details jsonb;
