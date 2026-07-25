/**
 * Append-only audit trail for OAuth first-party trust changes.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core"
import { users } from "./users"

export const oauthClientTrustAudit = pgTable(
  "oauth_client_trust_audit",
  {
    id: serial("id").primaryKey(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    previousIsFirstParty: boolean("previous_is_first_party").notNull(),
    newIsFirstParty: boolean("new_is_first_party").notNull(),
    changedBy: integer("changed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    changeSource: varchar("change_source", { length: 128 }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_oauth_client_trust_audit_client").on(
      table.clientId,
      table.changedAt
    ),
  ]
)

export type OAuthClientTrustAuditRow =
  typeof oauthClientTrustAudit.$inferSelect
