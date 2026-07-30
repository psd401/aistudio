import {
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export const deepResearchReservations = pgTable(
  "deep_research_reservations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reservedCostCents: integer("reserved_cost_cents").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    interactionId: text("interaction_id"),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_deep_research_active_user").on(
      table.userId,
      table.status,
      table.expiresAt
    ),
    index("idx_deep_research_budget_window").on(table.reservedAt),
    index("idx_deep_research_interaction_id")
      .on(table.interactionId)
      .where(sql`${table.interactionId} IS NOT NULL`),
  ]
);
