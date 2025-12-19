/**
 * Idea Notes Table Schema
 * Comments and notes on ideas
 */

import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { ideas } from "./ideas";
import { users } from "./users";

export const ideaNotes = pgTable("idea_notes", {
  id: serial("id").primaryKey(),
  ideaId: integer("idea_id")
    .references(() => ideas.id)
    .notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  userId: integer("user_id").references(() => users.id),
});
