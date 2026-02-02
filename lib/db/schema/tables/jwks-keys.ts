/**
 * JWKS Keys Table Schema
 * JWT signing key metadata for OIDC provider.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import {
  boolean,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core"

export const jwksKeys = pgTable("jwks_keys", {
  id: serial("id").primaryKey(),
  kid: varchar("kid", { length: 255 }).notNull().unique(),
  kmsKeyArn: varchar("kms_key_arn", { length: 512 }),
  algorithm: varchar("algorithm", { length: 10 }).notNull().default("RS256"),
  publicKeyPem: text("public_key_pem").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
