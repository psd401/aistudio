/**
 * Idea Votes Table Schema
 * User votes on ideas
 */

import { integer, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { ideas } from "./ideas";
import { users } from "./users";

export const ideaVotes = pgTable("idea_votes", {
  id: serial("id").primaryKey(),
  ideaId: integer("idea_id")
    .references(() => ideas.id)
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
