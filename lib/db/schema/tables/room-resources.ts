/**
 * AI Studio resources assigned to a room.
 *
 * Only Assistant Architect assistants are admitted in v1. The text resource ID
 * mirrors resource_access_grants and leaves the column extensible for a later
 * explicitly reviewed resource type.
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

export const ROOM_RESOURCE_TYPES = ["assistant"] as const;
export type RoomResourceType = (typeof ROOM_RESOURCE_TYPES)[number];

export const roomResources = pgTable(
  "room_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .references(() => rooms.id, { onDelete: "cascade" })
      .notNull(),
    resourceType: text("resource_type")
      .$type<RoomResourceType>()
      .notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_room_resource").on(
      table.roomId,
      table.resourceType,
      table.resourceId
    ),
    index("idx_room_resources_room_id").on(table.roomId),
    index("idx_room_resources_resource").on(
      table.resourceType,
      table.resourceId
    ),
  ]
);

export type RoomResourceRow = typeof roomResources.$inferSelect;
export type NewRoomResourceRow = typeof roomResources.$inferInsert;
