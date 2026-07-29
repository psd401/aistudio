/**
 * OneRoster class sections linked to teacher-managed rooms.
 *
 * The sourced ID intentionally has no foreign key to the sync-owned roster
 * tables. A roster refresh must never cascade into application-owned rooms.
 */

import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";

export const roomClasses = pgTable(
  "room_classes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .references(() => rooms.id, { onDelete: "cascade" })
      .notNull(),
    classSourcedId: text("class_sourced_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_room_class").on(table.roomId, table.classSourcedId),
    index("idx_room_classes_room_id").on(table.roomId),
    index("idx_room_classes_class_sourced_id").on(table.classSourcedId),
  ]
);

export type RoomClassRow = typeof roomClasses.$inferSelect;
export type NewRoomClassRow = typeof roomClasses.$inferInsert;
