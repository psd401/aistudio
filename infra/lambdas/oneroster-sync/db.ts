/**
 * postgres.js data layer for the isolated OneRoster sync Lambda.
 *
 * Every collection reconciles in its own transaction. Upserts and
 * absence-driven deactivation therefore commit together; malformed input or a
 * DB error rolls the collection back and preserves its last-known-good rows.
 * Bulk inserts are chunked below PostgreSQL's bind-parameter ceiling.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import postgres from "postgres";
import {
  normalizeAcademicSession,
  normalizeClass,
  normalizeCourse,
  normalizeEnrollment,
  normalizeOrg,
  normalizeUser,
  type NormalizedAcademicSession,
  type NormalizedClass,
  type NormalizedClassTerm,
  type NormalizedCourse,
  type NormalizedEnrollment,
  type NormalizedOrg,
  type NormalizedUser,
  type NormalizedUserRole,
} from "./normalize";
import type { CollectionPullSuccess } from "./oneroster-client";

const secretsClient = new SecretsManagerClient({});
const UPSERT_CHUNK_SIZE = 4_000;
const LAST_PERM_REV_SETTING_KEY = "ONEROSTER_LAST_PERM_REV";
// Keep synchronized with lib/roster/settings.ts and config.ts.
const SYNC_STATUS_SETTING_KEY = "ONEROSTER_SYNC_STATUS";

/**
 * OneRoster roles that represent district staff in the fixed v1 mapping.
 *
 * The first four values are the OneRoster-defined staff-shaped roles called
 * out by #1312. The remaining normalized values accommodate common
 * vendor-specific staff/administrator spellings without treating family roles
 * (parent, guardian, relative) or unknown input as staff authorization.
 */
const STAFF_ONEROSTER_ROLE_NAMES = [
  "teacher",
  "aide",
  "proctor",
  "administrator",
  "staff",
  "districtadministrator",
  "siteadministrator",
  "systemadministrator",
] as const;
const STAFF_ONEROSTER_ROLES = new Set<string>(
  STAFF_ONEROSTER_ROLE_NAMES
);

let sqlSingleton: postgres.Sql | null = null;
let initPromise: Promise<postgres.Sql> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

async function resolveCredentials(): Promise<{
  username: string;
  password: string;
}> {
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: requireEnv("DATABASE_SECRET_ARN"),
    })
  );
  if (!response.SecretString) {
    throw new Error("DATABASE_SECRET_ARN payload is empty");
  }
  const parsed = JSON.parse(response.SecretString) as Record<string, unknown>;
  if (typeof parsed.username !== "string" || !parsed.username) {
    throw new Error("DATABASE_SECRET_ARN payload is missing username");
  }
  if (typeof parsed.password !== "string" || !parsed.password) {
    throw new Error("DATABASE_SECRET_ARN payload is missing password");
  }
  return { username: parsed.username, password: parsed.password };
}

export async function getSql(): Promise<postgres.Sql> {
  if (!initPromise) {
    initPromise = (async () => {
      const credentials = await resolveCredentials();
      sqlSingleton = postgres({
        host: requireEnv("DATABASE_HOST"),
        port: Number.parseInt(process.env.DATABASE_PORT ?? "5432", 10),
        database: process.env.DATABASE_NAME ?? "aistudio",
        username: credentials.username,
        password: credentials.password,
        ssl: "require",
        max: 2,
        idle_timeout: 20,
        connect_timeout: 10,
      });
      return sqlSingleton;
    })();
  }
  return initPromise;
}

export async function closeSql(): Promise<void> {
  const sql = sqlSingleton;
  sqlSingleton = null;
  initPromise = null;
  if (sql) await sql.end({ timeout: 5 });
}

export async function getSettingValue(
  sql: postgres.Sql,
  key: string
): Promise<string | null> {
  const rows = await sql<{ value: string | null }[]>`
    SELECT value FROM settings WHERE key = ${key} LIMIT 1
  `;
  const value = rows[0]?.value?.trim();
  return value || null;
}

export async function readLastPermRev(sql: postgres.Sql): Promise<string | null> {
  return getSettingValue(sql, LAST_PERM_REV_SETTING_KEY);
}

export async function writeLastPermRev(
  sql: postgres.Sql,
  permRev: string
): Promise<void> {
  await sql`
    INSERT INTO settings (key, value, description)
    VALUES (
      ${LAST_PERM_REV_SETTING_KEY},
      ${permRev},
      'Internal checkpoint: x-perm-rev from the last fully successful OneRoster sync'
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          description = EXCLUDED.description,
          updated_at = now()
  `;
}

export async function writeSyncStatus(
  sql: postgres.Sql,
  status: unknown
): Promise<void> {
  await sql`
    INSERT INTO settings (
      key,
      value,
      description,
      category,
      is_secret
    )
    VALUES (
      ${SYNC_STATUS_SETTING_KEY},
      ${JSON.stringify(status)},
      'Internal OneRoster sync run status for the administrator dashboard',
      'integrations',
      false
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          is_secret = false,
          updated_at = now()
  `;
}

export type MappedApplicationRole = "student" | "staff";

/**
 * Fixed, fail-closed OneRoster → AI Studio role mapping (#1312).
 *
 * Application administrator is deliberately not a possible return value.
 */
export function mapOneRosterRoleToApplicationRole(
  role: string | null
): MappedApplicationRole | null {
  const normalized = role
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!normalized) return null;
  if (normalized === "student") return "student";
  return STAFF_ONEROSTER_ROLES.has(normalized) ? "staff" : null;
}

export interface RoleReconcileResult {
  /** OneRoster-owned user_roles rows inserted. */
  granted: number;
  /** OneRoster-owned user_roles rows removed. */
  revoked: number;
  /** Distinct users whose role_version was bumped. */
  usersChanged: number;
}

/**
 * Reconcile active roster roles into application roles in one transaction.
 *
 * Source ownership is the safety boundary:
 *   - computed student/staff roles are inserted as source='oneroster' only
 *     when the user does not already hold that role from any source;
 *   - only stale source='oneroster' rows are removable;
 *   - application administrator is excluded from both the mapping and delete.
 *
 * The administrator exclusion is structural, so this path cannot revoke admin
 * access and does not need LAST_ADMIN_GUARD_LOCK_KEY. Any future expansion that
 * can remove administrator must use the shared advisory-lock discipline.
 */
export async function reconcileOneRosterRoles(
  sql: postgres.Sql
): Promise<RoleReconcileResult> {
  return sql.begin(async (tx) => {
    const requiredRoles = await tx<{ name: string }[]>`
      SELECT lower(name) AS name
        FROM roles
       WHERE lower(name) = ANY(${["student", "staff"]}::text[])
    `;
    const availableRoles = new Set(requiredRoles.map((role) => role.name));
    const missingRoles = ["student", "staff"].filter(
      (role) => !availableRoles.has(role)
    );
    if (missingRoles.length > 0) {
      throw new Error(
        `Required application roles are missing: ${missingRoles.join(", ")}`
      );
    }

    await tx`
      CREATE TEMP TABLE _computed_oneroster_roles ON COMMIT DROP AS
      WITH mapped_roster_roles AS (
        SELECT DISTINCT
               application_user.id AS user_id,
               CASE
                 WHEN regexp_replace(
                   lower(trim(roster_role.role)),
                   '[^a-z0-9]+',
                   '',
                   'g'
                 ) = 'student'
                   THEN 'student'
                 WHEN regexp_replace(
                   lower(trim(roster_role.role)),
                   '[^a-z0-9]+',
                   '',
                   'g'
                 ) = ANY(${[...STAFF_ONEROSTER_ROLE_NAMES]}::text[])
                   THEN 'staff'
                 ELSE NULL
               END AS application_role_name
          FROM oneroster_users roster_user
          JOIN oneroster_user_roles roster_role
            ON roster_role.user_sourced_id = roster_user.sourced_id
           AND roster_role.is_active = true
          JOIN users application_user
            ON lower(application_user.email) = lower(roster_user.email)
         WHERE roster_user.is_active = true
           AND coalesce(roster_user.enabled_user, true) = true
           AND roster_user.email IS NOT NULL
      )
      SELECT mapped.user_id, application_role.id AS role_id
        FROM mapped_roster_roles mapped
        JOIN roles application_role
          ON lower(application_role.name) = mapped.application_role_name
       WHERE mapped.application_role_name IS NOT NULL
    `;
    await tx`ANALYZE _computed_oneroster_roles`;

    const granted = await tx<{ user_id: number }[]>`
      INSERT INTO user_roles (user_id, role_id, source)
      SELECT computed.user_id, computed.role_id, 'oneroster'
        FROM _computed_oneroster_roles computed
       WHERE NOT EXISTS (
         SELECT 1
           FROM user_roles existing
          WHERE existing.user_id = computed.user_id
            AND existing.role_id = computed.role_id
       )
      ON CONFLICT (user_id, role_id) DO NOTHING
      RETURNING user_id
    `;

    const revoked = await tx<{ user_id: number }[]>`
      DELETE FROM user_roles managed
       WHERE managed.source = 'oneroster'
         AND NOT EXISTS (
           SELECT 1
             FROM _computed_oneroster_roles computed
            WHERE computed.user_id = managed.user_id
              AND computed.role_id = managed.role_id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM roles protected_role
            WHERE protected_role.id = managed.role_id
              AND lower(protected_role.name) = 'administrator'
         )
      RETURNING managed.user_id
    `;

    const changedUserIds = [
      ...new Set([
        ...granted.map((row) => row.user_id),
        ...revoked.map((row) => row.user_id),
      ]),
    ];
    if (changedUserIds.length > 0) {
      await tx`
        UPDATE users
           SET role_version = coalesce(role_version, 0) + 1,
               updated_at = now()
         WHERE id = ANY(${changedUserIds}::int[])
      `;
    }

    return {
      granted: granted.length,
      revoked: revoked.length,
      usersChanged: changedUserIds.length,
    };
  });
}

export async function reconcileCollection(
  sql: postgres.Sql,
  collection: CollectionPullSuccess
): Promise<{ synced: number; deactivated: number }> {
  switch (collection.name) {
    case "orgs":
      return reconcileOrgs(sql, collection.records.map(normalizeOrg));
    case "academicSessions":
      return reconcileAcademicSessions(
        sql,
        collection.records.map(normalizeAcademicSession)
      );
    case "courses":
      return reconcileCourses(sql, collection.records.map(normalizeCourse));
    case "classes": {
      const normalized = collection.records.map(normalizeClass);
      return reconcileClasses(
        sql,
        normalized.map((entry) => entry.entity),
        normalized.flatMap((entry) => entry.terms)
      );
    }
    case "users": {
      const normalized = collection.records.map(normalizeUser);
      return reconcileUsers(
        sql,
        normalized.map((entry) => entry.entity),
        normalized.flatMap((entry) => entry.roles)
      );
    }
    case "enrollments":
      return reconcileEnrollments(
        sql,
        collection.records.map(normalizeEnrollment)
      );
  }
}

async function reconcileOrgs(
  sql: postgres.Sql,
  rows: NormalizedOrg[]
): Promise<{ synced: number; deactivated: number }> {
  return sql.begin(async (tx) => {
    const explicit = await deactivateExplicit(
      tx,
      "oneroster_orgs",
      rows
    );
    for (const chunk of chunks(rows)) {
      await tx`
        INSERT INTO oneroster_orgs ${tx(
          withSyncTime(chunk),
          "sourced_id",
          "name",
          "type",
          "identifier",
          "parent_sourced_id",
          "status",
          "is_active",
          "date_last_modified",
          "last_synced_at"
        )}
        ON CONFLICT (sourced_id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          identifier = EXCLUDED.identifier,
          parent_sourced_id = EXCLUDED.parent_sourced_id,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          date_last_modified = EXCLUDED.date_last_modified,
          last_synced_at = now()
      `;
    }
    const absent = await deactivateAbsent(tx, "oneroster_orgs", rows);
    return {
      synced: rows.length,
      deactivated: explicit + absent,
    };
  });
}

async function reconcileAcademicSessions(
  sql: postgres.Sql,
  rows: NormalizedAcademicSession[]
): Promise<{ synced: number; deactivated: number }> {
  return sql.begin(async (tx) => {
    const explicit = await deactivateExplicit(
      tx,
      "oneroster_academic_sessions",
      rows
    );
    for (const chunk of chunks(rows)) {
      await tx`
        INSERT INTO oneroster_academic_sessions ${tx(
          withSyncTime(chunk),
          "sourced_id",
          "title",
          "type",
          "start_date",
          "end_date",
          "parent_sourced_id",
          "school_year",
          "status",
          "is_active",
          "date_last_modified",
          "last_synced_at"
        )}
        ON CONFLICT (sourced_id) DO UPDATE SET
          title = EXCLUDED.title,
          type = EXCLUDED.type,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          parent_sourced_id = EXCLUDED.parent_sourced_id,
          school_year = EXCLUDED.school_year,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          date_last_modified = EXCLUDED.date_last_modified,
          last_synced_at = now()
      `;
    }
    const absent = await deactivateAbsent(
      tx,
      "oneroster_academic_sessions",
      rows
    );
    return { synced: rows.length, deactivated: explicit + absent };
  });
}

async function reconcileCourses(
  sql: postgres.Sql,
  rows: NormalizedCourse[]
): Promise<{ synced: number; deactivated: number }> {
  return sql.begin(async (tx) => {
    const explicit = await deactivateExplicit(tx, "oneroster_courses", rows);
    for (const chunk of chunks(rows)) {
      await tx`
        INSERT INTO oneroster_courses ${tx(
          withSyncTime(chunk),
          "sourced_id",
          "title",
          "course_code",
          "org_sourced_id",
          "grades",
          "status",
          "is_active",
          "date_last_modified",
          "last_synced_at"
        )}
        ON CONFLICT (sourced_id) DO UPDATE SET
          title = EXCLUDED.title,
          course_code = EXCLUDED.course_code,
          org_sourced_id = EXCLUDED.org_sourced_id,
          grades = EXCLUDED.grades,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          date_last_modified = EXCLUDED.date_last_modified,
          last_synced_at = now()
      `;
    }
    const absent = await deactivateAbsent(tx, "oneroster_courses", rows);
    return { synced: rows.length, deactivated: explicit + absent };
  });
}

async function reconcileClasses(
  sql: postgres.Sql,
  rows: NormalizedClass[],
  terms: NormalizedClassTerm[]
): Promise<{ synced: number; deactivated: number }> {
  return sql.begin(async (tx) => {
    const explicit = await deactivateExplicit(tx, "oneroster_classes", rows);
    for (const chunk of chunks(rows)) {
      await tx`
        INSERT INTO oneroster_classes ${tx(
          withSyncTime(chunk),
          "sourced_id",
          "title",
          "class_code",
          "class_type",
          "location",
          "course_sourced_id",
          "school_sourced_id",
          "grades",
          "subjects",
          "periods",
          "status",
          "is_active",
          "date_last_modified",
          "last_synced_at"
        )}
        ON CONFLICT (sourced_id) DO UPDATE SET
          title = EXCLUDED.title,
          class_code = EXCLUDED.class_code,
          class_type = EXCLUDED.class_type,
          location = EXCLUDED.location,
          course_sourced_id = EXCLUDED.course_sourced_id,
          school_sourced_id = EXCLUDED.school_sourced_id,
          grades = EXCLUDED.grades,
          subjects = EXCLUDED.subjects,
          periods = EXCLUDED.periods,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          date_last_modified = EXCLUDED.date_last_modified,
          last_synced_at = now()
      `;
    }
    const absent = await deactivateAbsent(tx, "oneroster_classes", rows);
    const termDeactivated = await reconcileClassTerms(tx, terms);
    return {
      synced: rows.length,
      deactivated: explicit + absent + termDeactivated,
    };
  });
}

async function reconcileClassTerms(
  tx: postgres.TransactionSql,
  rows: NormalizedClassTerm[]
): Promise<number> {
  await tx`
    CREATE TEMP TABLE _seen_oneroster_class_terms (
      class_sourced_id text NOT NULL,
      term_sourced_id text NOT NULL,
      status text NOT NULL,
      is_active boolean NOT NULL,
      date_last_modified timestamptz
    ) ON COMMIT DROP
  `;
  for (const chunk of chunks(rows)) {
    await tx`
      INSERT INTO _seen_oneroster_class_terms ${tx(
        chunk,
        "class_sourced_id",
        "term_sourced_id",
        "status",
        "is_active",
        "date_last_modified"
      )}
    `;
  }
  const deactivated = await tx<{ id: string }[]>`
    UPDATE oneroster_class_terms target
       SET is_active = false
     WHERE target.is_active = true
       AND NOT EXISTS (
         SELECT 1
           FROM _seen_oneroster_class_terms seen
          WHERE seen.class_sourced_id = target.class_sourced_id
            AND seen.term_sourced_id = target.term_sourced_id
            AND seen.is_active = true
       )
    RETURNING target.id
  `;
  await tx`
    INSERT INTO oneroster_class_terms (
      class_sourced_id,
      term_sourced_id,
      status,
      is_active,
      date_last_modified,
      last_synced_at
    )
    SELECT class_sourced_id, term_sourced_id, status, is_active,
           date_last_modified, now()
      FROM _seen_oneroster_class_terms
    ON CONFLICT (class_sourced_id, term_sourced_id) DO UPDATE SET
      status = EXCLUDED.status,
      is_active = EXCLUDED.is_active,
      date_last_modified = EXCLUDED.date_last_modified,
      last_synced_at = now()
  `;
  return deactivated.length;
}

async function reconcileUsers(
  sql: postgres.Sql,
  rows: NormalizedUser[],
  roles: NormalizedUserRole[]
): Promise<{ synced: number; deactivated: number }> {
  return sql.begin(async (tx) => {
    const explicit = await deactivateExplicit(tx, "oneroster_users", rows);
    for (const chunk of chunks(rows)) {
      await tx`
        INSERT INTO oneroster_users ${tx(
          withSyncTime(chunk),
          "sourced_id",
          "email",
          "username",
          "given_name",
          "family_name",
          "role",
          "enabled_user",
          "grades",
          "status",
          "is_active",
          "date_last_modified",
          "last_synced_at"
        )}
        ON CONFLICT (sourced_id) DO UPDATE SET
          email = EXCLUDED.email,
          username = EXCLUDED.username,
          given_name = EXCLUDED.given_name,
          family_name = EXCLUDED.family_name,
          role = EXCLUDED.role,
          enabled_user = EXCLUDED.enabled_user,
          grades = EXCLUDED.grades,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          date_last_modified = EXCLUDED.date_last_modified,
          last_synced_at = now()
      `;
    }
    const absent = await deactivateAbsent(tx, "oneroster_users", rows);
    const roleDeactivated = await reconcileUserRoles(tx, roles);
    return {
      synced: rows.length,
      deactivated: explicit + absent + roleDeactivated,
    };
  });
}

async function reconcileUserRoles(
  tx: postgres.TransactionSql,
  rows: NormalizedUserRole[]
): Promise<number> {
  await tx`
    CREATE TEMP TABLE _seen_oneroster_user_roles (
      user_sourced_id text NOT NULL,
      role text NOT NULL,
      role_type text NOT NULL,
      org_sourced_id text,
      status text NOT NULL,
      is_active boolean NOT NULL,
      date_last_modified timestamptz
    ) ON COMMIT DROP
  `;
  for (const chunk of chunks(rows)) {
    await tx`
      INSERT INTO _seen_oneroster_user_roles ${tx(
        chunk,
        "user_sourced_id",
        "role",
        "role_type",
        "org_sourced_id",
        "status",
        "is_active",
        "date_last_modified"
      )}
    `;
  }
  const deactivated = await tx<{ id: string }[]>`
    UPDATE oneroster_user_roles target
       SET is_active = false
     WHERE target.is_active = true
       AND NOT EXISTS (
         SELECT 1
           FROM _seen_oneroster_user_roles seen
          WHERE seen.user_sourced_id = target.user_sourced_id
            AND seen.role = target.role
            AND seen.role_type = target.role_type
            AND coalesce(seen.org_sourced_id, '') =
                coalesce(target.org_sourced_id, '')
            AND seen.is_active = true
       )
    RETURNING target.id
  `;
  await tx`
    INSERT INTO oneroster_user_roles (
      user_sourced_id,
      role,
      role_type,
      org_sourced_id,
      status,
      is_active,
      date_last_modified,
      last_synced_at
    )
    SELECT user_sourced_id, role, role_type, org_sourced_id, status, is_active,
           date_last_modified, now()
      FROM _seen_oneroster_user_roles
    ON CONFLICT (
      user_sourced_id,
      role,
      role_type,
      (coalesce(org_sourced_id, ''))
    ) DO UPDATE SET
      status = EXCLUDED.status,
      is_active = EXCLUDED.is_active,
      date_last_modified = EXCLUDED.date_last_modified,
      last_synced_at = now()
  `;
  return deactivated.length;
}

async function reconcileEnrollments(
  sql: postgres.Sql,
  rows: NormalizedEnrollment[]
): Promise<{ synced: number; deactivated: number }> {
  return sql.begin(async (tx) => {
    const explicit = await deactivateExplicit(
      tx,
      "oneroster_enrollments",
      rows
    );
    for (const chunk of chunks(rows)) {
      await tx`
        INSERT INTO oneroster_enrollments ${tx(
          withSyncTime(chunk),
          "sourced_id",
          "user_sourced_id",
          "class_sourced_id",
          "school_sourced_id",
          "role",
          "is_primary",
          "begin_date",
          "end_date",
          "status",
          "is_active",
          "date_last_modified",
          "last_synced_at"
        )}
        ON CONFLICT (sourced_id) DO UPDATE SET
          user_sourced_id = EXCLUDED.user_sourced_id,
          class_sourced_id = EXCLUDED.class_sourced_id,
          school_sourced_id = EXCLUDED.school_sourced_id,
          role = EXCLUDED.role,
          is_primary = EXCLUDED.is_primary,
          begin_date = EXCLUDED.begin_date,
          end_date = EXCLUDED.end_date,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          date_last_modified = EXCLUDED.date_last_modified,
          last_synced_at = now()
      `;
    }
    const absent = await deactivateAbsent(
      tx,
      "oneroster_enrollments",
      rows
    );
    return { synced: rows.length, deactivated: explicit + absent };
  });
}

type SourcedRow = {
  sourced_id: string;
  status: "active" | "tobedeleted";
};

type EntityTable =
  | "oneroster_orgs"
  | "oneroster_academic_sessions"
  | "oneroster_courses"
  | "oneroster_classes"
  | "oneroster_users"
  | "oneroster_enrollments";

async function deactivateExplicit(
  tx: postgres.TransactionSql,
  table: EntityTable,
  rows: SourcedRow[]
): Promise<number> {
  const ids = rows
    .filter((row) => row.status === "tobedeleted")
    .map((row) => row.sourced_id);
  if (ids.length === 0) return 0;
  const updated = await tx.unsafe<{ id: string }[]>(
    `UPDATE ${table}
        SET is_active = false
      WHERE is_active = true
        AND sourced_id = ANY($1::text[])
      RETURNING id`,
    [ids]
  );
  return updated.length;
}

async function deactivateAbsent(
  tx: postgres.TransactionSql,
  table: EntityTable,
  rows: SourcedRow[]
): Promise<number> {
  const ids = rows.map((row) => row.sourced_id);
  const updated = await tx.unsafe<{ id: string }[]>(
    `UPDATE ${table}
        SET is_active = false
      WHERE is_active = true
        AND sourced_id <> ALL($1::text[])
      RETURNING id`,
    [ids]
  );
  return updated.length;
}

function chunks<T>(rows: T[]): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += UPSERT_CHUNK_SIZE) {
    output.push(rows.slice(index, index + UPSERT_CHUNK_SIZE));
  }
  return output;
}

function withSyncTime<T extends object>(
  rows: T[]
): Array<T & { last_synced_at: Date }> {
  const syncedAt = new Date();
  return rows.map((row) => ({ ...row, last_synced_at: syncedAt }));
}
