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

import { and, eq, sql, type SQL } from "drizzle-orm";
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

export interface StudentRoomAssistant {
  id: number;
  name: string;
  description: string | null;
  imagePath: string | null;
}

export interface StudentRoom {
  id: string;
  name: string;
  assistants: StudentRoomAssistant[];
}

export interface RoomAssistantAccessContext {
  isAdministrator: boolean;
  isStudentOnly: boolean;
  hasActiveRoomMembership: boolean;
  assignedAssistantIds: Set<string>;
}

interface StudentRoomRow {
  id: string;
  name: string;
  assistantId: number | null;
  assistantName: string | null;
  assistantDescription: string | null;
  assistantImagePath: string | null;
}

/**
 * The canonical reverse-membership query. It deliberately resolves the
 * application user's current email at query time and lowercases both sides of
 * every cross-system comparison.
 */
function memberRoomsQuery(userId: number, roomId?: string): SQL {
  const roomFilter = roomId ? sql`AND r.id = ${roomId}` : sql``;
  return sql`
    SELECT r.id, r.name
      FROM rooms r
      JOIN users actor ON actor.id = ${userId}
     WHERE r.is_active = true
       ${roomFilter}
       AND (
         EXISTS (
           SELECT 1
             FROM room_members rm
            WHERE rm.room_id = r.id
              AND lower(rm.member_email) = lower(actor.email)
         )
         OR EXISTS (
           SELECT 1
             FROM room_classes rc
             JOIN oneroster_classes c
               ON c.sourced_id = rc.class_sourced_id
              AND c.is_active = true
             JOIN oneroster_enrollments e
               ON e.class_sourced_id = rc.class_sourced_id
              AND e.is_active = true
              AND lower(coalesce(e.role, '')) = 'student'
             JOIN oneroster_users roster_user
               ON roster_user.sourced_id = e.user_sourced_id
              AND roster_user.is_active = true
            WHERE rc.room_id = r.id
              AND lower(roster_user.email) = lower(actor.email)
         )
       )
  `;
}

async function loadRoomsForUser(
  userId: number,
  roomId?: string
): Promise<StudentRoom[]> {
  if (!Number.isInteger(userId) || userId <= 0) return [];

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        WITH member_rooms AS (
          ${memberRoomsQuery(userId, roomId)}
          ORDER BY name, id
          LIMIT 100
        )
        SELECT
          member_rooms.id,
          member_rooms.name,
          assistant.id AS "assistantId",
          assistant.name AS "assistantName",
          assistant.description AS "assistantDescription",
          assistant.image_path AS "assistantImagePath"
        FROM member_rooms
        LEFT JOIN room_resources resource
          ON resource.room_id = member_rooms.id
         AND resource.resource_type = 'assistant'
        LEFT JOIN assistant_architects assistant
          ON assistant.id::text = resource.resource_id
         AND assistant.status = 'approved'
        ORDER BY member_rooms.name, member_rooms.id, assistant.name, assistant.id
      `),
    roomId ? "roomForUser" : "roomsForUser"
  );

  const byId = new Map<string, StudentRoom>();
  for (const row of toPgRows<StudentRoomRow>(result)) {
    const room = byId.get(row.id) ?? {
      id: row.id,
      name: row.name,
      assistants: [],
    };
    if (row.assistantId !== null && row.assistantName !== null) {
      room.assistants.push({
        id: row.assistantId,
        name: row.assistantName,
        description: row.assistantDescription,
        imagePath: row.assistantImagePath,
      });
    }
    byId.set(row.id, room);
  }
  return [...byId.values()];
}

/** Return every active room the application user currently belongs to. */
export async function roomsForUser(userId: number): Promise<StudentRoom[]> {
  return loadRoomsForUser(userId);
}

/**
 * Resolve one room through the membership boundary. A missing result is
 * intentionally indistinguishable from a nonexistent room so route callers can
 * return 404 without disclosing room existence.
 */
export async function roomForUser(
  userId: number,
  roomId: string
): Promise<StudentRoom | null> {
  const [room] = await loadRoomsForUser(userId, roomId);
  return room ?? null;
}

/**
 * Load the room-specific inputs used by the shared assistant authorization
 * gate. Room assignment grants access to any member. Restriction applies only
 * when `isStudentOnly && hasActiveRoomMembership`; administrators are surfaced
 * separately so the resource layer can preserve its existing bypass.
 */
export async function getRoomAssistantAccessContext(
  userId: number,
  assistantIds: Array<number | string>
): Promise<RoomAssistantAccessContext> {
  const validUser = Number.isInteger(userId) && userId > 0;
  if (!validUser) {
    return {
      isAdministrator: false,
      isStudentOnly: false,
      hasActiveRoomMembership: false,
      assignedAssistantIds: new Set<string>(),
    };
  }

  const idTexts = [...new Set(assistantIds.map(String))];
  const assignmentFilter =
    idTexts.length === 0
      ? sql`false`
      : sql`resource.resource_id IN (${sql.join(
          idTexts.map((id) => sql`${id}`),
          sql`, `
        )})`;

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        WITH member_rooms AS (
          ${memberRoomsQuery(userId)}
        )
        SELECT
          EXISTS (
            SELECT 1
              FROM user_roles ur
              JOIN roles role ON role.id = ur.role_id
             WHERE ur.user_id = ${userId}
               AND lower(role.name) = 'administrator'
          ) AS "isAdministrator",
          (
            EXISTS (
              SELECT 1
                FROM user_roles ur
                JOIN roles role ON role.id = ur.role_id
               WHERE ur.user_id = ${userId}
                 AND lower(role.name) = 'student'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM user_roles ur
                JOIN roles role ON role.id = ur.role_id
               WHERE ur.user_id = ${userId}
                 AND lower(role.name) <> 'student'
            )
          ) AS "isStudentOnly",
          EXISTS (SELECT 1 FROM member_rooms) AS "hasActiveRoomMembership",
          COALESCE(
            (
              SELECT array_agg(DISTINCT resource.resource_id)
                FROM member_rooms
                JOIN room_resources resource
                  ON resource.room_id = member_rooms.id
                 AND resource.resource_type = 'assistant'
               WHERE ${assignmentFilter}
            ),
            ARRAY[]::text[]
          ) AS "assignedAssistantIds"
      `),
    "getRoomAssistantAccessContext"
  );
  const [row] = toPgRows<{
    isAdministrator: boolean;
    isStudentOnly: boolean;
    hasActiveRoomMembership: boolean;
    assignedAssistantIds: string[];
  }>(result);

  return {
    isAdministrator: row?.isAdministrator === true,
    isStudentOnly: row?.isStudentOnly === true,
    hasActiveRoomMembership: row?.hasActiveRoomMembership === true,
    assignedAssistantIds: new Set(row?.assignedAssistantIds ?? []),
  };
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
 * Efficient authorization-shaped point check kept here so section and
 * explicit-member semantics have one implementation.
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
