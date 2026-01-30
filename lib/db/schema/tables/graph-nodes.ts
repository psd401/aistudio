/**
 * Graph Nodes Table Schema
 * Stores nodes in the context graph for decision reasoning capture
 * Part of Context Graph Foundation epic (Issues #665, #666)
 */

import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { GraphNodeMetadata } from "@/lib/db/types/jsonb";
import { users } from "./users";

export const graphNodes = pgTable("graph_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeType: text("node_type").notNull(),
  nodeClass: text("node_class").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  metadata: jsonb("metadata").$type<GraphNodeMetadata>().default({}),
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
