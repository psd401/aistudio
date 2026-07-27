import {
  bigint,
  boolean,
  index,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { pgTable } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const workspaceUploadReservations = pgTable(
  "workspace_upload_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerKey: varchar("owner_key", { length: 256 }).notNull(),
    contextKey: varchar("context_key", { length: 256 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    publicArtifact: boolean("public_artifact").notNull(),
    stagingKey: varchar("staging_key", { length: 1024 }).notNull(),
    targetKey: varchar("target_key", { length: 1024 }).notNull(),
    expectedBytes: bigint("expected_bytes", { mode: "number" }).notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 44 }).notNull(),
    contentType: varchar("content_type", { length: 255 }).notNull(),
    // Nullable since migration 154: the upload admission gates are
    // observe-only, so an upload may proceed over-threshold with no lease to
    // record. NULL means "admitted without a lease" — reconciliation treats it
    // as nothing to release, not as an error.
    byteLeaseId: varchar("byte_lease_id", { length: 36 }),
    objectLeaseId: varchar("object_lease_id", { length: 36 }),
    status: varchar("status", { length: 16 }).notNull().default("reserved"),
    objectVersionId: varchar("object_version_id", { length: 1024 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_workspace_upload_idempotency").on(
      table.ownerKey,
      table.idempotencyKey,
    ),
    uniqueIndex("uq_workspace_upload_target_active")
      .on(table.ownerKey, table.targetKey)
      .where(sql`status IN ('reserved', 'verifying')`),
    index("idx_workspace_upload_owner_status").on(
      table.ownerKey,
      table.publicArtifact,
      table.status,
    ),
    index("idx_workspace_upload_expiry").on(table.status, table.expiresAt),
  ],
)
