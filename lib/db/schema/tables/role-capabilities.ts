/**
 * Role Capabilities Table Schema
 *
 * Many-to-many relationship between roles and capabilities.
 * Renamed successor to the legacy `role_tools` table.
 *
 * Issue #923 (Epic #922) — Unify Agent Platform.
 */

import {
  integer,
  index,
  pgTable,
  serial,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { capabilities } from "./capabilities";

export const roleCapabilities = pgTable(
  "role_capabilities",
  {
    id: serial("id").primaryKey(),
    // NOT NULL: a grant row is meaningless without both sides. The SQL migration
    // (079) and the UNIQUE(role_id, capability_id) constraint both assume this —
    // a NULL key would satisfy UNIQUE independently and never join.
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    capabilityId: integer("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // Mirrors UNIQUE(role_id, capability_id) in migration 079. Load-bearing:
    // assignCapabilityToRole uses .onConflictDoNothing() for idempotency.
    unique("role_capabilities_role_id_capability_id_key").on(
      t.roleId,
      t.capabilityId
    ),
    index("idx_role_capabilities_role_id").on(t.roleId),
    index("idx_role_capabilities_capability_id").on(t.capabilityId),
  ]
);

export type RoleCapability = typeof roleCapabilities.$inferSelect;
export type NewRoleCapability = typeof roleCapabilities.$inferInsert;
