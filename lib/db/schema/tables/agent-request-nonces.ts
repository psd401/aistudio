import {
  index,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core"

/**
 * One-time request proof nonces for model-adjacent agent broker calls.
 *
 * The nonce primary key is the atomic replay barrier. Rows live only until
 * the invocation context expires and are opportunistically cleaned up while
 * consuming later requests.
 */
export const psdAgentRequestNonces = pgTable(
  "psd_agent_request_nonces",
  {
    nonce: varchar("nonce", { length: 36 }).primaryKey(),
    invocationNonce: varchar("invocation_nonce", { length: 128 }).notNull(),
    ownerEmail: varchar("owner_email", { length: 320 }).notNull(),
    method: varchar("method", { length: 12 }).notNull(),
    route: varchar("route", { length: 512 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_psd_agent_request_nonces_expiry").on(table.expiresAt),
    index("idx_psd_agent_request_nonces_invocation").on(
      table.invocationNonce,
      table.createdAt
    ),
  ]
)
