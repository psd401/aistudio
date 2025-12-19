/**
 * Repository Item Chunks Table Schema
 * Chunked content with vector embeddings for semantic search
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  customType,
} from "drizzle-orm/pg-core";
import { repositoryItems } from "./repository-items";

// Custom type for pgvector
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

export const repositoryItemChunks = pgTable("repository_item_chunks", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id")
    .references(() => repositoryItems.id)
    .notNull(),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  embedding: vector("embedding"),
  tokens: integer("tokens"),
  createdAt: timestamp("created_at").defaultNow(),
});
