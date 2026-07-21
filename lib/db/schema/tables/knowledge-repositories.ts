/**
 * Knowledge Repositories Table Schema
 * Organized collections of knowledge items
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const knowledgeRepositories = pgTable("knowledge_repositories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  isPublic: boolean("is_public").default(false),
  repositoryKind: varchar("repository_kind", { length: 16 })
    .$type<"durable" | "ephemeral" | "system">()
    .default("durable")
    .notNull(),
  lifecycleStatus: varchar("lifecycle_status", { length: 16 })
    .$type<"active" | "expired" | "deleting" | "deleted">()
    .default("active")
    .notNull(),
  retentionDays: integer("retention_days"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Deferred SQL FK to repository_index_generations.id (migration 116). */
  activeIndexGenerationId: uuid("active_index_generation_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
