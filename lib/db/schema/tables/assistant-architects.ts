/**
 * Assistant Architects Table Schema
 * AI-powered prompt chain workflows
 */

import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { toolStatusEnum } from "../enums";
import { users } from "./users";

export const assistantArchitects = pgTable("assistant_architects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: toolStatusEnum("status").default("draft").notNull(),
  isParallel: boolean("is_parallel").default(false).notNull(),
  timeoutSeconds: integer("timeout_seconds"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  imagePath: text("image_path"),
  userId: integer("user_id").references(() => users.id),
});
