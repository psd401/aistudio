/**
 * Repository Items Table Schema
 * Individual items within knowledge repositories
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";

export const repositoryItems = pgTable("repository_items", {
  id: serial("id").primaryKey(),
  repositoryId: integer("repository_id")
    .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
    .notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  processingStatus: text("processing_status").default("pending"),
  processingError: text("processing_error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
