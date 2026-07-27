/**
 * Canonical room-membership resolution (Epic #1308 / Issue #1313).
 *
 * Membership is the union of:
 *  - active student enrollments in active OneRoster sections linked to a room
 *  - explicit lowercased email rows in room_members
 *
 * Email remains a cross-system join key, so every comparison lowercases both
 * sides even though normal writes already store lowercase values.
 */

import { and, eq, sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import {
  onerosterClasses,
  onerosterEnrollments,
  onerosterUsers,
  roomClasses,
  roomMembers,
  rooms,
} from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/groups/normalize";

export function mergeRoomMembershipEmails(
  sectionEmails: Array<string | null>,
  explicitEmails: Array<string | null>
): string[] {
  const unique = new Set<string>();
  for (const value of [...sectionEmails, ...explicitEmails]) {
    const email = normalizeEmail(value);
    if (email) unique.add(email);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

/**
 * Return the room's current membership snapshot as normalized email addresses.
 * The section half follows roster changes dynamically; no student rows are
 * copied into application-owned tables.
 */
export async function resolveRoomMembershipEmails(
  roomId: string
): Promise<string[]> {
  const [sectionRows, explicitRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({ email: onerosterUsers.email })
          .from(roomClasses)
          .innerJoin(
            rooms,
            and(eq(rooms.id, roomClasses.roomId), eq(rooms.isActive, true))
          )
          .innerJoin(
            onerosterClasses,
            and(
              eq(
                onerosterClasses.sourcedId,
                roomClasses.classSourcedId
              ),
              eq(onerosterClasses.isActive, true)
            )
          )
          .innerJoin(
            onerosterEnrollments,
            and(
              eq(
                onerosterEnrollments.classSourcedId,
                roomClasses.classSourcedId
              ),
              eq(onerosterEnrollments.isActive, true),
              sql`lower(coalesce(${onerosterEnrollments.role}, '')) = 'student'`
            )
          )
          .innerJoin(
            onerosterUsers,
            and(
              eq(
                onerosterUsers.sourcedId,
                onerosterEnrollments.userSourcedId
              ),
              eq(onerosterUsers.isActive, true)
            )
          )
          .where(eq(roomClasses.roomId, roomId)),
      "resolveRoomMembershipEmails.sections"
    ),
    executeQuery(
      (db) =>
        db
          .select({ email: roomMembers.memberEmail })
          .from(roomMembers)
          .innerJoin(
            rooms,
            and(eq(rooms.id, roomMembers.roomId), eq(rooms.isActive, true))
          )
          .where(eq(roomMembers.roomId, roomId)),
      "resolveRoomMembershipEmails.explicit"
    ),
  ]);

  return mergeRoomMembershipEmails(
    sectionRows.map((row) => row.email),
    explicitRows.map((row) => row.email)
  );
}

/**
 * Efficient authorization-shaped point check used by the student experience in
 * the next workstream. Kept here so section and explicit-member semantics have
 * one implementation.
 */
export async function isRoomMember(
  roomId: string,
  memberEmail: string
): Promise<boolean> {
  const email = normalizeEmail(memberEmail);
  if (!email) return false;

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT (
          EXISTS (
            SELECT 1
              FROM rooms r
              JOIN room_members rm ON rm.room_id = r.id
             WHERE r.id = ${roomId}
               AND r.is_active = true
               AND lower(rm.member_email) = lower(${email})
          )
          OR EXISTS (
            SELECT 1
              FROM rooms r
              JOIN room_classes rc ON rc.room_id = r.id
              JOIN oneroster_classes c
                ON c.sourced_id = rc.class_sourced_id
               AND c.is_active = true
              JOIN oneroster_enrollments e
                ON e.class_sourced_id = rc.class_sourced_id
               AND e.is_active = true
               AND lower(coalesce(e.role, '')) = 'student'
              JOIN oneroster_users u
                ON u.sourced_id = e.user_sourced_id
               AND u.is_active = true
             WHERE r.id = ${roomId}
               AND r.is_active = true
               AND lower(u.email) = lower(${email})
          )
        ) AS is_member
      `),
    "isRoomMember"
  );
  const [row] = toPgRows<{ is_member: boolean }>(result);
  return row?.is_member === true;
}
