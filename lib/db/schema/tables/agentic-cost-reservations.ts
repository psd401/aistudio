import {
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { users } from "./users"

export const agenticCostReservations = pgTable(
  "agentic_cost_reservations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    executionId: integer("execution_id").notNull(),
    reservedCostCents: integer("reserved_cost_cents").notNull(),
    actualCostCents: integer("actual_cost_cents"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_agentic_cost_execution").on(table.executionId),
    index("idx_agentic_cost_active_user").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    index("idx_agentic_cost_budget_window").on(table.reservedAt),
  ],
)
