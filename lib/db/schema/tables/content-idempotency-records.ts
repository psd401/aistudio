/**
 * Durable idempotency records for Atrium REST mutations (#1287).
 *
 * Raw Idempotency-Key values and request bodies are never stored. The unique
 * scope follows the public contract: environment + authenticated principal +
 * OAuth/API client + HTTP method + canonical route + SHA-256 key digest.
 * Completed response bodies are encrypted before persistence and expire after
 * seven days.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type ContentIdempotencyState = "pending" | "completed";
export type ContentIdempotencyHeaders = Record<string, string>;

export const contentIdempotencyRecords = pgTable(
  "content_idempotency_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: varchar("environment", { length: 64 }).notNull(),
    principal: varchar("principal", { length: 128 }).notNull(),
    client: varchar("client", { length: 160 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    route: varchar("route", { length: 512 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    state: varchar("state", { length: 16 })
      .$type<ContentIdempotencyState>()
      .default("pending")
      .notNull(),
    responseStatus: integer("response_status"),
    responseHeaders: jsonb("response_headers").$type<ContentIdempotencyHeaders>(),
    responseCiphertext: text("response_ciphertext"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_content_idempotency_scope").on(
      t.environment,
      t.principal,
      t.client,
      t.method,
      t.route,
      t.keyHash
    ),
    index("idx_content_idempotency_expiry").on(t.expiresAt),
  ]
);

export type ContentIdempotencyRecordRow =
  typeof contentIdempotencyRecords.$inferSelect;
