/**
 * Users Table Schema
 * Core user authentication and profile data
 */

import {
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  cognitoSub: varchar("cognito_sub", { length: 255 }).unique(),
  email: varchar("email", { length: 255 }),
  firstName: varchar("first_name", { length: 255 }),
  lastName: varchar("last_name", { length: 255 }),
  lastSignInAt: timestamp("last_sign_in_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  oldClerkId: varchar("old_clerk_id", { length: 255 }).unique(),
  roleVersion: integer("role_version").default(1),
});
