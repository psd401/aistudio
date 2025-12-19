/**
 * Migration Mappings Table Schema
 * ID mappings from legacy data migrations
 */

import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const migrationMappings = pgTable(
  "migration_mappings",
  {
    tableName: varchar("table_name", { length: 100 }).notNull(),
    oldId: text("old_id").notNull(),
    newId: integer("new_id"),
    oldIdType: varchar("old_id_type", { length: 50 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tableName, table.oldId] }),
  })
);
