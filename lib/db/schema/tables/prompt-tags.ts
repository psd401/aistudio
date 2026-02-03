/**
 * Prompt Tags Table Schema
 * Tag taxonomy for prompt library
 */

import { pgTable, serial, timestamp, varchar } from "drizzle-orm/pg-core";

export const promptTags = pgTable("prompt_tags", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
