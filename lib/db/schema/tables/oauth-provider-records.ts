/**
 * Durable storage for oidc-provider models that do not have dedicated tables.
 * Raw provider identifiers are never stored; idHash is SHA-256(id).
 *
 * Issue #1285.
 */

import { jsonb, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core"

export type OidcAdapterJson = Record<string, unknown>

export const oauthProviderRecords = pgTable(
  "oauth_provider_records",
  {
    model: varchar("model", { length: 64 }).notNull(),
    idHash: varchar("id_hash", { length: 64 }).notNull(),
    uid: varchar("uid", { length: 255 }),
    grantId: varchar("grant_id", { length: 255 }),
    adapterPayload: jsonb("adapter_payload").$type<OidcAdapterJson>().notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.model, table.idHash] })]
)
