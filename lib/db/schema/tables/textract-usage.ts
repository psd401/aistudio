/**
 * Textract Usage Table Schema
 * Monthly AWS Textract usage tracking
 */

import {
  date,
  integer,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";

export const textractUsage = pgTable("textract_usage", {
  month: date("month").primaryKey(),
  pageCount: integer("page_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
