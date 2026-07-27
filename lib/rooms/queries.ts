/**
 * Read accessors for teacher room management.
 *
 * Roster tables are read-only. Every teacher-section query lowercases both
 * sides of the email join and every result is bounded to the room-management
 * surface's needs.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import {
  assistantArchitects,
  roomClasses,
  roomMembers,
  roomResources,
  rooms,
  users,
} from "@/lib/db/schema";
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access";
import { normalizeEmail } from "@/lib/groups/normalize";

export interface TeacherSectionOption {
  sourcedId: string;
  title: string | null;
  classCode: string | null;
  schoolName: string | null;
  studentCount: number;
}

export interface RosterStudentOption {
  email: string;
  givenName: string | null;
  familyName: string | null;
}

export interface AccessibleAssistantOption {
  id: number;
  name: string;
  description: string | null;
}

export interface ManagedRoom {
  id: string;
  name: string;
  createdBy: number | null;
  /**
   * Owner email, or null for an orphaned room (creator deleted — `rooms.created_by`
   * is ON DELETE SET NULL). Only meaningful to administrators, the only actors
   * served rooms they did not create.
   */
  createdByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  classSourcedIds: string[];
  memberEmails: string[];
  assistantIds: number[];
}

/**
 * Upper bound on rows returned by `listRoomsForManagement`. Only reachable by
 * administrators, whose list spans every owner in the district; a teacher's own
 * rooms are far below it.
 */
export const MANAGED_ROOM_LIST_LIMIT = 500;

export interface RoomAuthorizationSnapshot {
  createdBy: number | null;
  classSourcedIds: string[];
}

export async function listTeacherSections(
  teacherEmail: string
): Promise<TeacherSectionOption[]> {
  const email = normalizeEmail(teacherEmail);
  if (!email) return [];

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT DISTINCT
          c.sourced_id AS "sourcedId",
          c.title,
          c.class_code AS "classCode",
          school.name AS "schoolName",
          (
            SELECT count(DISTINCT student_e.user_sourced_id)::int
              FROM oneroster_enrollments student_e
             WHERE student_e.class_sourced_id = c.sourced_id
               AND student_e.is_active = true
               AND lower(coalesce(student_e.role, '')) = 'student'
          ) AS "studentCount"
        FROM oneroster_classes c
        JOIN oneroster_enrollments teacher_e
          ON teacher_e.class_sourced_id = c.sourced_id
         AND teacher_e.is_active = true
         AND lower(coalesce(teacher_e.role, '')) = 'teacher'
        JOIN oneroster_users teacher_u
          ON teacher_u.sourced_id = teacher_e.user_sourced_id
         AND teacher_u.is_active = true
        LEFT JOIN oneroster_orgs school
          ON school.sourced_id = c.school_sourced_id
         AND school.is_active = true
        WHERE c.is_active = true
          AND lower(teacher_u.email) = lower(${email})
        ORDER BY c.title NULLS LAST, c.sourced_id
      `),
    "listTeacherSections"
  );

  return toPgRows<TeacherSectionOption>(result);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function searchActiveRosterStudents(
  search: string,
  teacherEmail: string,
  isAdministrator: boolean,
  limit = 25
): Promise<RosterStudentOption[]> {
  const normalized = search.trim().toLowerCase();
  const normalizedTeacherEmail = normalizeEmail(teacherEmail);
  if (normalized.length < 2) return [];
  if (!isAdministrator && !normalizedTeacherEmail) return [];
  const boundedLimit = Math.max(1, Math.min(limit, 25));
  const pattern = `%${escapeLikePattern(normalized)}%`;

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT DISTINCT
          lower(u.email) AS email,
          u.given_name AS "givenName",
          u.family_name AS "familyName"
        FROM oneroster_users u
        WHERE u.is_active = true
          AND u.email IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM oneroster_enrollments e
             WHERE e.user_sourced_id = u.sourced_id
               AND e.is_active = true
               AND lower(coalesce(e.role, '')) = 'student'
               AND (
                 ${isAdministrator}
                 OR EXISTS (
                   SELECT 1
                     FROM oneroster_enrollments teacher_e
                     JOIN oneroster_users teacher_u
                       ON teacher_u.sourced_id = teacher_e.user_sourced_id
                      AND teacher_u.is_active = true
                    WHERE teacher_e.is_active = true
                      AND lower(coalesce(teacher_e.role, '')) = 'teacher'
                      AND lower(teacher_u.email) = lower(${normalizedTeacherEmail})
                      AND teacher_e.school_sourced_id IS NOT NULL
                      AND teacher_e.school_sourced_id = e.school_sourced_id
                 )
               )
          )
          AND (
            lower(u.email) LIKE ${pattern} ESCAPE '\'
            OR lower(
              trim(concat_ws(' ', u.given_name, u.family_name))
            ) LIKE ${pattern} ESCAPE '\'
          )
        ORDER BY email
        LIMIT ${boundedLimit}
      `),
    "searchActiveRosterStudents"
  );

  return toPgRows<RosterStudentOption>(result);
}

/**
 * Resolve requested explicit members through the same server-owned roster
 * boundary as the student picker. Administrators may select any active roster
 * student; staff are limited to students enrolled in a school where they have
 * an active teacher enrollment.
 */
export async function accessibleActiveRosterStudentEmails(
  teacherEmail: string,
  isAdministrator: boolean,
  requestedEmails: string[]
): Promise<Set<string>> {
  const emails = [
    ...new Set(requestedEmails.map(normalizeEmail).filter(Boolean)),
  ];
  if (emails.length === 0) return new Set<string>();
  const normalizedTeacherEmail = normalizeEmail(teacherEmail);
  if (!isAdministrator && !normalizedTeacherEmail) return new Set<string>();

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT DISTINCT lower(u.email) AS email
          FROM oneroster_users u
         WHERE u.is_active = true
           AND u.email IS NOT NULL
           AND lower(u.email) IN (
             ${sql.join(
               emails.map((email) => sql`${email}`),
               sql`, `
             )}
           )
           AND EXISTS (
             SELECT 1
               FROM oneroster_enrollments e
              WHERE e.user_sourced_id = u.sourced_id
                AND e.is_active = true
                AND lower(coalesce(e.role, '')) = 'student'
                AND (
                  ${isAdministrator}
                  OR EXISTS (
                    SELECT 1
                      FROM oneroster_enrollments teacher_e
                      JOIN oneroster_users teacher_u
                        ON teacher_u.sourced_id = teacher_e.user_sourced_id
                       AND teacher_u.is_active = true
                     WHERE teacher_e.is_active = true
                       AND lower(coalesce(teacher_e.role, '')) = 'teacher'
                       AND lower(teacher_u.email) = lower(${normalizedTeacherEmail})
                       AND teacher_e.school_sourced_id IS NOT NULL
                       AND teacher_e.school_sourced_id = e.school_sourced_id
                  )
                )
           )
      `),
    "accessibleActiveRosterStudentEmails"
  );

  return new Set(
    toPgRows<{ email: string }>(result).map((row) =>
      normalizeEmail(row.email)
    )
  );
}

export async function listAccessibleApprovedAssistants(
  userId: number
): Promise<AccessibleAssistantOption[]> {
  const candidates = await executeQuery(
    (db) =>
      db
        .select({
          id: assistantArchitects.id,
          name: assistantArchitects.name,
          description: assistantArchitects.description,
        })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.status, "approved"))
        .orderBy(assistantArchitects.name),
    "listAccessibleApprovedAssistants.candidates"
  );
  const accessible = await filterAccessibleResourceIds(
    userId,
    "assistant",
    candidates.map((candidate) => candidate.id)
  );
  return candidates.filter((candidate) => accessible.has(String(candidate.id)));
}

export async function accessibleApprovedAssistantIds(
  userId: number,
  requestedIds: number[]
): Promise<Set<number>> {
  if (requestedIds.length === 0) return new Set<number>();
  const approved = await executeQuery(
    (db) =>
      db
        .select({ id: assistantArchitects.id })
        .from(assistantArchitects)
        .where(
          and(
            eq(assistantArchitects.status, "approved"),
            inArray(assistantArchitects.id, requestedIds)
          )
        ),
    "accessibleApprovedAssistantIds.approved"
  );
  const accessible = await filterAccessibleResourceIds(
    userId,
    "assistant",
    approved.map((candidate) => candidate.id)
  );
  return new Set(
    approved
      .map((candidate) => candidate.id)
      .filter((id) => accessible.has(String(id)))
  );
}

/**
 * Rooms the actor may manage: their own, or — for an administrator — every
 * active room, so the administrator override in `canManageRoom` is reachable
 * from the UI instead of only by knowing a room's UUID.
 *
 * The administrator result set is district-wide, so it is capped at
 * `MANAGED_ROOM_LIST_LIMIT` (most recently updated first). The cap is load-
 * bearing, not cosmetic: every returned id is spread into three `IN (...)`
 * child-row queries below, so an uncapped list would grow the bind-parameter
 * count and the payload serialized into the client component linearly with the
 * number of rooms in the district. A searchable/paged administrator view is
 * follow-up work.
 */
export async function listRoomsForManagement(
  userId: number,
  isAdministrator: boolean
): Promise<ManagedRoom[]> {
  const roomRows = await executeQuery(
    (db) =>
      db
        .select({
          id: rooms.id,
          name: rooms.name,
          createdBy: rooms.createdBy,
          createdByEmail: users.email,
          createdAt: rooms.createdAt,
          updatedAt: rooms.updatedAt,
        })
        .from(rooms)
        .leftJoin(users, eq(users.id, rooms.createdBy))
        .where(
          isAdministrator
            ? eq(rooms.isActive, true)
            : and(eq(rooms.createdBy, userId), eq(rooms.isActive, true))
        )
        .orderBy(desc(rooms.updatedAt))
        .limit(MANAGED_ROOM_LIST_LIMIT),
    "listRoomsForManagement.rooms"
  );
  if (roomRows.length === 0) return [];

  const roomIds = roomRows.map((room) => room.id);
  const [classRows, memberRows, resourceRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            roomId: roomClasses.roomId,
            classSourcedId: roomClasses.classSourcedId,
          })
          .from(roomClasses)
          .where(inArray(roomClasses.roomId, roomIds)),
      "listRoomsForManagement.classes"
    ),
    executeQuery(
      (db) =>
        db
          .select({
            roomId: roomMembers.roomId,
            memberEmail: roomMembers.memberEmail,
          })
          .from(roomMembers)
          .where(inArray(roomMembers.roomId, roomIds)),
      "listRoomsForManagement.members"
    ),
    executeQuery(
      (db) =>
        db
          .select({
            roomId: roomResources.roomId,
            resourceId: roomResources.resourceId,
          })
          .from(roomResources)
          .where(
            and(
              inArray(roomResources.roomId, roomIds),
              eq(roomResources.resourceType, "assistant")
            )
          ),
      "listRoomsForManagement.resources"
    ),
  ]);

  return roomRows.map((room) => ({
    ...room,
    // Left join: null whenever the creator row is gone (created_by SET NULL).
    createdByEmail: room.createdByEmail ?? null,
    classSourcedIds: classRows
      .filter((row) => row.roomId === room.id)
      .map((row) => row.classSourcedId),
    memberEmails: memberRows
      .filter((row) => row.roomId === room.id)
      .map((row) => normalizeEmail(row.memberEmail))
      .sort((a, b) => a.localeCompare(b)),
    assistantIds: resourceRows
      .filter((row) => row.roomId === room.id)
      .map((row) => Number(row.resourceId))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  }));
}

export async function getRoomAuthorizationSnapshot(
  roomId: string
): Promise<RoomAuthorizationSnapshot | null> {
  const [roomRow, classRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({ createdBy: rooms.createdBy })
          .from(rooms)
          .where(and(eq(rooms.id, roomId), eq(rooms.isActive, true)))
          .limit(1),
      "getRoomAuthorizationSnapshot.room"
    ),
    executeQuery(
      (db) =>
        db
          .select({ classSourcedId: roomClasses.classSourcedId })
          .from(roomClasses)
          .where(eq(roomClasses.roomId, roomId)),
      "getRoomAuthorizationSnapshot.classes"
    ),
  ]);
  if (!roomRow[0]) return null;
  return {
    createdBy: roomRow[0].createdBy,
    classSourcedIds: classRows.map((row) => row.classSourcedId),
  };
}

export async function getRoomActor(
  userId: number
): Promise<{ email: string; isAdministrator: boolean } | null> {
  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          u.email,
          EXISTS (
            SELECT 1
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id
               AND lower(r.name) = 'administrator'
          ) AS "isAdministrator"
        FROM users u
        WHERE u.id = ${userId}
        LIMIT 1
      `),
    "getRoomActor"
  );
  const [row] = toPgRows<{
    email: string | null;
    isAdministrator: boolean;
  }>(result);
  if (!row?.email) return null;
  return {
    email: row.email,
    isAdministrator: row.isAdministrator === true,
  };
}
