/**
 * Read-only OneRoster accessors for the administrator roster browser.
 *
 * The sync Lambda exclusively owns roster writes. These queries expose bounded
 * school/class/roster views and aggregate collection health without copying
 * raw roster records into logs or application-owned tables.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  onerosterAcademicSessions,
  onerosterClasses,
  onerosterClassTerms,
  onerosterCourses,
  onerosterEnrollments,
  onerosterOrgs,
  onerosterUsers,
} from "@/lib/db/schema";
import {
  getOneRosterSyncStatus,
  type OneRosterCollectionName,
  type OneRosterSyncStatus,
} from "./status";

export interface RosterCollectionSummary {
  name: OneRosterCollectionName;
  total: number;
  active: number;
  inactive: number;
  lastSyncedAt: Date | null;
}

export interface OneRosterSyncOverview {
  collections: RosterCollectionSummary[];
  lastRunAt: Date | null;
  status: OneRosterSyncStatus | null;
}

export interface RosterSchool {
  sourcedId: string;
  name: string | null;
  identifier: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
}

export interface RosterClass {
  sourcedId: string;
  title: string | null;
  classCode: string | null;
  location: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  terms: string[];
  teachers: string[];
  studentCount: number;
}

export interface RosterStudent {
  enrollmentSourcedId: string;
  userSourcedId: string | null;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  isPrimary: boolean | null;
  enrollmentActive: boolean;
  userActive: boolean | null;
  lastSyncedAt: Date | null;
}

const aggregateSelection = <T extends {
  isActive: unknown;
  lastSyncedAt: unknown;
}>(table: T) => ({
  total: sql<number>`count(*)::int`,
  active: sql<number>`count(*) filter (where ${table.isActive})::int`,
  lastSyncedAt: sql<Date | null>`max(${table.lastSyncedAt})`,
});

export async function getOneRosterSyncOverview(): Promise<OneRosterSyncOverview> {
  const [
    orgRows,
    sessionRows,
    courseRows,
    classRows,
    userRows,
    enrollmentRows,
    status,
  ] = await Promise.all([
    executeQuery(
      (db) => db.select(aggregateSelection(onerosterOrgs)).from(onerosterOrgs),
      "getOneRosterSyncOverview:orgs"
    ),
    executeQuery(
      (db) =>
        db
          .select(aggregateSelection(onerosterAcademicSessions))
          .from(onerosterAcademicSessions),
      "getOneRosterSyncOverview:academicSessions"
    ),
    executeQuery(
      (db) =>
        db.select(aggregateSelection(onerosterCourses)).from(onerosterCourses),
      "getOneRosterSyncOverview:courses"
    ),
    executeQuery(
      (db) =>
        db.select(aggregateSelection(onerosterClasses)).from(onerosterClasses),
      "getOneRosterSyncOverview:classes"
    ),
    executeQuery(
      (db) => db.select(aggregateSelection(onerosterUsers)).from(onerosterUsers),
      "getOneRosterSyncOverview:users"
    ),
    executeQuery(
      (db) =>
        db
          .select(aggregateSelection(onerosterEnrollments))
          .from(onerosterEnrollments),
      "getOneRosterSyncOverview:enrollments"
    ),
    getOneRosterSyncStatus(),
  ]);

  const rows = [
    ["orgs", orgRows[0]],
    ["academicSessions", sessionRows[0]],
    ["courses", courseRows[0]],
    ["classes", classRows[0]],
    ["users", userRows[0]],
    ["enrollments", enrollmentRows[0]],
  ] as const;
  const collections = rows.map(([name, row]) => {
    const total = row?.total ?? 0;
    const active = row?.active ?? 0;
    return {
      name,
      total,
      active,
      inactive: Math.max(0, total - active),
      lastSyncedAt: row?.lastSyncedAt ?? null,
    };
  });
  const completedAt = status?.completedAt ? new Date(status.completedAt) : null;
  const tableLastRun = collections.reduce<Date | null>((latest, collection) => {
    if (!collection.lastSyncedAt) return latest;
    return !latest || collection.lastSyncedAt > latest
      ? collection.lastSyncedAt
      : latest;
  }, null);

  return {
    collections,
    lastRunAt:
      completedAt && (!tableLastRun || completedAt > tableLastRun)
        ? completedAt
        : tableLastRun,
    status,
  };
}

export async function listRosterSchools(): Promise<RosterSchool[]> {
  return executeQuery(
    (db) =>
      db
        .select({
          sourcedId: onerosterOrgs.sourcedId,
          name: onerosterOrgs.name,
          identifier: onerosterOrgs.identifier,
          isActive: onerosterOrgs.isActive,
          lastSyncedAt: onerosterOrgs.lastSyncedAt,
        })
        .from(onerosterOrgs)
        .where(sql`lower(coalesce(${onerosterOrgs.type}, '')) = 'school'`)
        .orderBy(desc(onerosterOrgs.isActive), asc(onerosterOrgs.name)),
    "listRosterSchools"
  );
}

export async function listRosterClasses(
  schoolSourcedId: string
): Promise<RosterClass[]> {
  const teacherEnrollments = alias(
    onerosterEnrollments,
    "roster_teacher_enrollments"
  );
  const teacherUsers = alias(onerosterUsers, "roster_teacher_users");
  const studentEnrollments = alias(
    onerosterEnrollments,
    "roster_student_enrollments"
  );

  return executeQuery(
    (db) =>
      db
        .select({
          sourcedId: onerosterClasses.sourcedId,
          title: onerosterClasses.title,
          classCode: onerosterClasses.classCode,
          location: onerosterClasses.location,
          isActive: onerosterClasses.isActive,
          lastSyncedAt: onerosterClasses.lastSyncedAt,
          terms: sql<string[]>`
            coalesce(
              array_agg(distinct ${onerosterAcademicSessions.title})
                filter (
                  where ${onerosterClassTerms.isActive}
                    and ${onerosterAcademicSessions.isActive}
                    and ${onerosterAcademicSessions.title} is not null
                ),
              '{}'::text[]
            )
          `,
          teachers: sql<string[]>`
            coalesce(
              array_agg(
                distinct trim(
                  concat_ws(
                    ' ',
                    ${teacherUsers.givenName},
                    ${teacherUsers.familyName}
                  )
                )
              ) filter (
                where ${teacherEnrollments.isActive}
                  and ${teacherUsers.isActive}
                  and lower(coalesce(${teacherEnrollments.role}, '')) = 'teacher'
                  and (
                    ${teacherUsers.givenName} is not null
                    or ${teacherUsers.familyName} is not null
                  )
              ),
              '{}'::text[]
            )
          `,
          studentCount: sql<number>`
            count(distinct ${studentEnrollments.userSourcedId})
              filter (
                where ${studentEnrollments.isActive}
                  and lower(coalesce(${studentEnrollments.role}, '')) = 'student'
              )::int
          `,
        })
        .from(onerosterClasses)
        .leftJoin(
          onerosterClassTerms,
          eq(
            onerosterClassTerms.classSourcedId,
            onerosterClasses.sourcedId
          )
        )
        .leftJoin(
          onerosterAcademicSessions,
          eq(
            onerosterAcademicSessions.sourcedId,
            onerosterClassTerms.termSourcedId
          )
        )
        .leftJoin(
          teacherEnrollments,
          and(
            eq(
              teacherEnrollments.classSourcedId,
              onerosterClasses.sourcedId
            ),
            sql`lower(coalesce(${teacherEnrollments.role}, '')) = 'teacher'`
          )
        )
        .leftJoin(
          teacherUsers,
          eq(teacherUsers.sourcedId, teacherEnrollments.userSourcedId)
        )
        .leftJoin(
          studentEnrollments,
          and(
            eq(
              studentEnrollments.classSourcedId,
              onerosterClasses.sourcedId
            ),
            sql`lower(coalesce(${studentEnrollments.role}, '')) = 'student'`
          )
        )
        .where(eq(onerosterClasses.schoolSourcedId, schoolSourcedId))
        .groupBy(onerosterClasses.id)
        .orderBy(desc(onerosterClasses.isActive), asc(onerosterClasses.title)),
    "listRosterClasses"
  );
}

export async function listRosterStudents(
  classSourcedId: string
): Promise<RosterStudent[]> {
  return executeQuery(
    (db) =>
      db
        .select({
          enrollmentSourcedId: onerosterEnrollments.sourcedId,
          userSourcedId: onerosterEnrollments.userSourcedId,
          email: onerosterUsers.email,
          givenName: onerosterUsers.givenName,
          familyName: onerosterUsers.familyName,
          isPrimary: onerosterEnrollments.isPrimary,
          enrollmentActive: onerosterEnrollments.isActive,
          userActive: onerosterUsers.isActive,
          lastSyncedAt: onerosterEnrollments.lastSyncedAt,
        })
        .from(onerosterEnrollments)
        .leftJoin(
          onerosterUsers,
          eq(onerosterUsers.sourcedId, onerosterEnrollments.userSourcedId)
        )
        .where(
          and(
            eq(onerosterEnrollments.classSourcedId, classSourcedId),
            sql`lower(coalesce(${onerosterEnrollments.role}, '')) = 'student'`
          )
        )
        .orderBy(
          desc(onerosterEnrollments.isActive),
          asc(onerosterUsers.familyName),
          asc(onerosterUsers.givenName),
          asc(onerosterUsers.email)
        ),
    "listRosterStudents"
  );
}
