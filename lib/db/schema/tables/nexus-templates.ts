/**
 * Nexus Templates Table Schema
 * Reusable prompt templates
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { NexusTemplateVariable } from "@/lib/db/types/jsonb";
import { users } from "./users";

export const nexusTemplates = pgTable("nexus_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: integer("user_id").references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  prompt: text("prompt").notNull(),
  variables: jsonb("variables").$type<NexusTemplateVariable[]>().default([]),
  isPublic: boolean("is_public").default(false),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
