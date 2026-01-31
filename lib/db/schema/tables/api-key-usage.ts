/**
 * API Key Usage Table Schema
 * Tracks every API call for rate limiting and analytics
 * Part of Epic #674 (External API Platform) - Issue #684
 */

import {
  bigserial,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";

export const apiKeyUsage = pgTable("api_key_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  apiKeyId: integer("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  endpoint: varchar("endpoint", { length: 255 }).notNull(),
  method: varchar("method", { length: 10 }).notNull(),
  statusCode: integer("status_code"),
  requestAt: timestamp("request_at", { withTimezone: true }).notNull().defaultNow(),
  responseTimeMs: integer("response_time_ms"),
  ipAddress: varchar("ip_address", { length: 45 }),
});
