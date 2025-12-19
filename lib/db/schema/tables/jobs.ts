/**
 * Jobs Table Schema
 * Background job queue
 */

import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jobStatusEnum } from "../enums";
import { users } from "./users";

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  status: jobStatusEnum("status").default("pending").notNull(),
  type: text("type").notNull(),
  input: text("input").notNull(),
  output: text("output"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
