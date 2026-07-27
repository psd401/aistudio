/**
 * Explicit room members keyed by lowercased email.
 *
 * Email, rather than a users FK, preserves membership for students who have not
 * signed in. Every authorization comparison still lowercases both sides.
 */

import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";

export const roomMembers = pgTable(
  "room_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .references(() => rooms.id, { onDelete: "cascade" })
      .notNull(),
    memberEmail: text("member_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_room_member").on(
      table.roomId,
      sql`lower(${table.memberEmail})`
    ),
    index("idx_room_members_room_id").on(table.roomId),
    index("idx_room_members_email").on(sql`lower(${table.memberEmail})`),
  ]
);

export type RoomMemberRow = typeof roomMembers.$inferSelect;
export type NewRoomMemberRow = typeof roomMembers.$inferInsert;
