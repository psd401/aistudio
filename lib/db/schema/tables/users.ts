/**
 * Users Table Schema
 * Core user authentication and profile data
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { UserProfile } from "@/lib/db/types/jsonb";

export const users = pgTable(
  "users",
  {
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
    // Profile fields (migration 051 - Issue #684)
    jobTitle: varchar("job_title", { length: 255 }),
    department: varchar("department", { length: 255 }),
    building: varchar("building", { length: 255 }),
    gradeLevels: text("grade_levels").array(),
    bio: text("bio"),
    profile: jsonb("profile").$type<UserProfile>().default(sql`'{}'::jsonb`),
  },
  (table) => ({
    // Email is an authorization join key (group membership → roles/resource
    // grants join on lower(email)); migration 112 (#1207) enforces it is
    // single-valued. NULLs are permitted and distinct (pre-provisioning rows).
    emailLowerUnique: uniqueIndex("uq_users_email_lower").on(
      sql`lower(${table.email})`
    ),
  })
);
