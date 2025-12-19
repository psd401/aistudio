/**
 * Repository Access Table Schema
 * Access control for knowledge repositories
 */

import { integer, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";
import { users } from "./users";
import { roles } from "./roles";

export const repositoryAccess = pgTable("repository_access", {
  id: serial("id").primaryKey(),
  repositoryId: integer("repository_id")
    .references(() => knowledgeRepositories.id)
    .notNull(),
  userId: integer("user_id").references(() => users.id),
  roleId: integer("role_id").references(() => roles.id),
  createdAt: timestamp("created_at").defaultNow(),
});
