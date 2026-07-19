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
import { vector } from "../custom-types";
import { users } from "./users";

export const graphNodes = pgTable("graph_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeType: text("node_type").notNull(),
  nodeClass: text("node_class").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  metadata: jsonb("metadata").$type<GraphNodeMetadata>().default({}),
  // Decision lifecycle (Issue #1252). MADR 4.0 status on decision-typed nodes
  // (proposed | accepted | superseded | rejected); NULL for non-decision nodes.
  // `supersededAt` is set when a newer decision supersedes this one.
  status: text("status"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  // 512-dim entity-resolution / semantic-search embedding (Issue #1252),
  // populated at capture time by lib/graph/graph-embeddings.ts. Nullable —
  // capture degrades gracefully when the embedding call fails.
  embedding: vector("embedding", 512),
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
