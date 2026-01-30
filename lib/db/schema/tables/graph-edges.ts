/**
 * Graph Edges Table Schema
 * Stores edges (relationships) between nodes in the context graph
 * Part of Context Graph Foundation epic (Issues #665, #666)
 */

import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { GraphEdgeMetadata } from "@/lib/db/types/jsonb";
import { graphNodes } from "./graph-nodes";
import { users } from "./users";

export const graphEdges = pgTable(
  "graph_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceNodeId: uuid("source_node_id")
      .references(() => graphNodes.id, { onDelete: "cascade" })
      .notNull(),
    targetNodeId: uuid("target_node_id")
      .references(() => graphNodes.id, { onDelete: "cascade" })
      .notNull(),
    edgeType: text("edge_type").notNull(),
    metadata: jsonb("metadata").$type<GraphEdgeMetadata>().default({}),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    // Unique constraint: allows multiple relationship types between same node pair
    uniqueEdge: unique("uq_edge_source_target_type").on(
      table.sourceNodeId,
      table.targetNodeId,
      table.edgeType
    ),
    // Check constraint: prevent self-referencing edges
    noSelfReference: check(
      "chk_no_self_reference",
      sql`${table.sourceNodeId} != ${table.targetNodeId}`
    ),
  })
);
