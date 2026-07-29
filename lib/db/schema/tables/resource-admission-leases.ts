import {
  bigint,
  index,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import { pgTable } from "drizzle-orm/pg-core"

export const resourceAdmissionLeases = pgTable(
  "resource_admission_leases",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    kind: varchar("kind", { length: 64 }).notNull(),
    ownerKey: varchar("owner_key", { length: 256 }).notNull(),
    contextKey: varchar("context_key", { length: 256 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
    reservedUnits: bigint("reserved_units", { mode: "number" }).notNull(),
    actualUnits: bigint("actual_units", { mode: "number" }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_resource_admission_idempotency").on(
      table.kind,
      table.ownerKey,
      table.idempotencyKey,
    ),
    index("idx_resource_admission_active").on(
      table.kind,
      table.status,
      table.expiresAt,
    ),
    index("idx_resource_admission_owner_window").on(
      table.kind,
      table.ownerKey,
      table.admittedAt,
    ),
    index("idx_resource_admission_global_window").on(
      table.kind,
      table.admittedAt,
    ),
    index("idx_resource_admission_terminal_cleanup").on(
      table.kind,
      table.status,
      table.finishedAt,
    ),
  ],
)
