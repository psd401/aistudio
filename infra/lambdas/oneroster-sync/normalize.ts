/**
 * OneRoster response normalization for the isolated sync Lambda.
 *
 * The upstream is untrusted JSON. These helpers narrow values without `any`,
 * preserve only the v1 roster fields, and lowercase the cross-system email key.
 * Demographics are deliberately absent from this module and the client.
 */

export type JsonRecord = Record<string, unknown>;
export type OneRosterStatus = "active" | "tobedeleted";

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`OneRoster record is missing required ${field}`);
  }
  return normalized;
}

export function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(optionalString)
    .filter((entry): entry is string => entry !== null);
}

export function sourcedIdFromRef(value: unknown): string | null {
  return isRecord(value) ? optionalString(value.sourcedId) : null;
}

export function firstSourcedId(value: unknown): string | null {
  if (!Array.isArray(value)) return sourcedIdFromRef(value);
  for (const entry of value) {
    const sourcedId = sourcedIdFromRef(entry);
    if (sourcedId) return sourcedId;
  }
  return null;
}

export function normalizeEmail(value: unknown): string | null {
  const email = optionalString(value);
  return email ? email.toLowerCase() : null;
}

export function normalizeStatus(value: unknown): OneRosterStatus {
  const compact = optionalString(value)?.replaceAll(/[-_\s]/g, "").toLowerCase();
  return compact === "tobedeleted" ? "tobedeleted" : "active";
}

export function dateValue(value: unknown): string | null {
  const raw = optionalString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("OneRoster record contains an invalid date value");
  }
  return raw;
}

export function dateTimeValue(value: unknown): string | null {
  return dateValue(value);
}

export interface NormalizedOrg {
  sourced_id: string;
  name: string | null;
  type: string | null;
  identifier: string | null;
  parent_sourced_id: string | null;
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export function normalizeOrg(record: JsonRecord): NormalizedOrg {
  const status = normalizeStatus(record.status);
  return {
    sourced_id: requiredString(record.sourcedId, "sourcedId"),
    name: optionalString(record.name),
    type: optionalString(record.type),
    identifier: optionalString(record.identifier),
    parent_sourced_id: sourcedIdFromRef(record.parent),
    status,
    is_active: status !== "tobedeleted",
    date_last_modified: dateTimeValue(record.dateLastModified),
  };
}

export interface NormalizedAcademicSession {
  sourced_id: string;
  title: string | null;
  type: string | null;
  start_date: string | null;
  end_date: string | null;
  parent_sourced_id: string | null;
  school_year: string | null;
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export function normalizeAcademicSession(
  record: JsonRecord
): NormalizedAcademicSession {
  const status = normalizeStatus(record.status);
  return {
    sourced_id: requiredString(record.sourcedId, "sourcedId"),
    title: optionalString(record.title),
    type: optionalString(record.type),
    start_date: dateValue(record.startDate),
    end_date: dateValue(record.endDate),
    parent_sourced_id: sourcedIdFromRef(record.parent),
    school_year: optionalString(record.schoolYear),
    status,
    is_active: status !== "tobedeleted",
    date_last_modified: dateTimeValue(record.dateLastModified),
  };
}

export interface NormalizedCourse {
  sourced_id: string;
  title: string | null;
  course_code: string | null;
  org_sourced_id: string | null;
  grades: string[];
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export function normalizeCourse(record: JsonRecord): NormalizedCourse {
  const status = normalizeStatus(record.status);
  return {
    sourced_id: requiredString(record.sourcedId, "sourcedId"),
    title: optionalString(record.title),
    course_code: optionalString(record.courseCode),
    org_sourced_id: firstSourcedId(record.orgs ?? record.org),
    grades: stringArray(record.grades),
    status,
    is_active: status !== "tobedeleted",
    date_last_modified: dateTimeValue(record.dateLastModified),
  };
}

export interface NormalizedClass {
  sourced_id: string;
  title: string | null;
  class_code: string | null;
  class_type: string | null;
  location: string | null;
  course_sourced_id: string | null;
  school_sourced_id: string | null;
  grades: string[];
  subjects: string[];
  periods: string[];
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export interface NormalizedClassTerm {
  class_sourced_id: string;
  term_sourced_id: string;
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export function normalizeClass(record: JsonRecord): {
  entity: NormalizedClass;
  terms: NormalizedClassTerm[];
} {
  const sourcedId = requiredString(record.sourcedId, "sourcedId");
  const status = normalizeStatus(record.status);
  const dateLastModified = dateTimeValue(record.dateLastModified);
  const termIds = Array.isArray(record.terms)
    ? record.terms
        .map(sourcedIdFromRef)
        .filter((entry): entry is string => entry !== null)
    : [];
  return {
    entity: {
      sourced_id: sourcedId,
      title: optionalString(record.title),
      class_code: optionalString(record.classCode),
      class_type: optionalString(record.classType),
      location: optionalString(record.location),
      course_sourced_id: sourcedIdFromRef(record.course),
      school_sourced_id: sourcedIdFromRef(record.school),
      grades: stringArray(record.grades),
      subjects: stringArray(record.subjects),
      periods: stringArray(record.periods),
      status,
      is_active: status !== "tobedeleted",
      date_last_modified: dateLastModified,
    },
    terms: [...new Set(termIds)].map((termId) => ({
      class_sourced_id: sourcedId,
      term_sourced_id: termId,
      status,
      is_active: status !== "tobedeleted",
      date_last_modified: dateLastModified,
    })),
  };
}

export interface NormalizedUser {
  sourced_id: string;
  email: string | null;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  role: string | null;
  enabled_user: boolean | null;
  grades: string[];
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export interface NormalizedUserRole {
  user_sourced_id: string;
  role: string;
  role_type: string;
  org_sourced_id: string | null;
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export function normalizeUser(record: JsonRecord): {
  entity: NormalizedUser;
  roles: NormalizedUserRole[];
} {
  const sourcedId = requiredString(record.sourcedId, "sourcedId");
  const status = normalizeStatus(record.status);
  const dateLastModified = dateTimeValue(record.dateLastModified);
  const roles: NormalizedUserRole[] = [];
  if (Array.isArray(record.roles)) {
    for (const rawRole of record.roles) {
      if (!isRecord(rawRole)) continue;
      const role = optionalString(rawRole.role);
      if (!role) continue;
      roles.push({
        user_sourced_id: sourcedId,
        role,
        role_type: optionalString(rawRole.roleType) ?? "primary",
        org_sourced_id: sourcedIdFromRef(rawRole.org),
        status,
        is_active: status !== "tobedeleted",
        date_last_modified: dateLastModified,
      });
    }
  }
  const legacyRole = optionalString(record.role);
  if (roles.length === 0 && legacyRole) {
    roles.push({
      user_sourced_id: sourcedId,
      role: legacyRole,
      role_type: "primary",
      org_sourced_id: firstSourcedId(record.orgs),
      status,
      is_active: status !== "tobedeleted",
      date_last_modified: dateLastModified,
    });
  }
  const primaryRole =
    roles.find((entry) => entry.role_type.toLowerCase() === "primary")?.role ??
    roles[0]?.role ??
    legacyRole;
  return {
    entity: {
      sourced_id: sourcedId,
      email: normalizeEmail(record.email),
      username: optionalString(record.username),
      given_name: optionalString(record.givenName),
      family_name: optionalString(record.familyName),
      role: primaryRole,
      enabled_user: optionalBoolean(record.enabledUser),
      grades: stringArray(record.grades),
      status,
      is_active: status !== "tobedeleted",
      date_last_modified: dateLastModified,
    },
    roles: dedupeUserRoles(roles),
  };
}

function dedupeUserRoles(roles: NormalizedUserRole[]): NormalizedUserRole[] {
  const seen = new Set<string>();
  return roles.filter((entry) => {
    const key = [
      entry.user_sourced_id,
      entry.role.toLowerCase(),
      entry.role_type.toLowerCase(),
      entry.org_sourced_id?.toLowerCase() ?? "",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface NormalizedEnrollment {
  sourced_id: string;
  user_sourced_id: string | null;
  class_sourced_id: string | null;
  school_sourced_id: string | null;
  role: string | null;
  is_primary: boolean | null;
  begin_date: string | null;
  end_date: string | null;
  status: OneRosterStatus;
  is_active: boolean;
  date_last_modified: string | null;
}

export function normalizeEnrollment(record: JsonRecord): NormalizedEnrollment {
  const status = normalizeStatus(record.status);
  return {
    sourced_id: requiredString(record.sourcedId, "sourcedId"),
    user_sourced_id: sourcedIdFromRef(record.user),
    class_sourced_id: sourcedIdFromRef(record.class),
    school_sourced_id: sourcedIdFromRef(record.school),
    role: optionalString(record.role),
    is_primary: optionalBoolean(record.primary),
    begin_date: dateValue(record.beginDate),
    end_date: dateValue(record.endDate),
    status,
    is_active: status !== "tobedeleted",
    date_last_modified: dateTimeValue(record.dateLastModified),
  };
}
