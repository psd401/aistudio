/**
 * Durable, auth-method-neutral API rate reservations.
 *
 * A row is inserted before dispatch. Principal identifiers are SHA-256 digests,
 * so session subjects and OAuth client identifiers are not retained here.
 */

import {
  bigserial,
  index,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const apiRateLimitReservations = pgTable(
  "api_rate_limit_reservations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    principalHash: varchar("principal_hash", { length: 64 }).notNull(),
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    requestAt: timestamp("request_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_api_rate_reservations_principal_time").on(
      table.principalHash,
      table.requestAt
    ),
    index("idx_api_rate_reservations_time").on(table.requestAt),
  ]
);
