/**
 * Textract Jobs Table Schema
 * AWS Textract processing job tracking
 */

import {
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { repositoryItems } from "./repository-items";

export const textractJobs = pgTable("textract_jobs", {
  jobId: varchar("job_id", { length: 255 }).primaryKey(),
  itemId: integer("item_id")
    .references(() => repositoryItems.id)
    .notNull(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
