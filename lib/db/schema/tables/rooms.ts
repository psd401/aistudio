/**
 * Teacher-managed rooms composed from OneRoster sections and explicit students.
 *
 * See migration 157-rooms.sql (Epic #1308 / Issue #1313).
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_rooms_created_by").on(table.createdBy),
    index("idx_rooms_is_active").on(table.isActive),
  ]
);

export type RoomRow = typeof rooms.$inferSelect;
export type NewRoomRow = typeof rooms.$inferInsert;
