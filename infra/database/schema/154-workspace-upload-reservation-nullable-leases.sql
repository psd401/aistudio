-- ============================================================================
-- 154: allow workspace upload reservations without admission leases
-- ============================================================================
--
-- WHY. `byte_lease_id` and `object_lease_id` were created NOT NULL (migration
-- 153) because an upload could only be reserved after BOTH admission gates
-- granted a lease — a denial threw and no row was ever written.
--
-- Those gates are now OBSERVE-ONLY: crossing a threshold is measured and
-- logged, and the upload proceeds. The limits shipped in #1353 were set
-- without data on what this workload actually consumes, and a user must not
-- be blocked by a number nobody validated. See lib/agent-workspace/
-- storage-broker.ts.
--
-- An upload that proceeded over-threshold therefore has NO lease to record,
-- and NOT NULL would make the reservation insert fail — turning an advisory
-- limit back into a hard block through the back door.
--
-- The columns exist so the reconciliation path can release or settle leases
-- later. NULL simply means "this upload was admitted without a lease", which
-- reconciliation must treat as nothing to release rather than as an error.
--
-- SAFE + REVERSIBLE. DROP NOT NULL never rewrites the table and cannot fail on
-- existing rows: every row written so far has both ids populated, and they
-- stay valid. Re-adding NOT NULL later would require those rows to be clean,
-- which is why the rollback below is deliberately not automatic.
-- ============================================================================

ALTER TABLE workspace_upload_reservations
  ALTER COLUMN byte_lease_id DROP NOT NULL;

ALTER TABLE workspace_upload_reservations
  ALTER COLUMN object_lease_id DROP NOT NULL;
