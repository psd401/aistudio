/**
 * Postgres.js data layer for the group-sync Lambda (Epic #1202, Phase 0 / #1203).
 *
 * Resolves Aurora credentials from Secrets Manager at cold start and exposes the
 * DB-backed ports the reconciler drives (upsert group, full-replace membership in
 * a transaction, mark synced/error, deactivate). The Lambda is an isolated bundle
 * and cannot import @/lib/db — the SQL here is the authoritative writer for
 * group_members (the app never mutates that table). Mirrors the connection
 * pattern of infra/lambdas/embedding-generator/db-client.ts.
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import postgres from "postgres";
import type { GroupSource } from "./sync";

const secretsClient = new SecretsManagerClient({});

const DATABASE_HOST = requireEnv("DATABASE_HOST");
const DATABASE_SECRET_ARN = requireEnv("DATABASE_SECRET_ARN");
const DATABASE_NAME = process.env.DATABASE_NAME ?? "aistudio";
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT ?? "5432", 10);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

let _sql: postgres.Sql | null = null;
let _initPromise: Promise<postgres.Sql> | null = null;

async function resolveCredentials(): Promise<{ username: string; password: string }> {
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN })
  );
  if (!res.SecretString) throw new Error("DATABASE_SECRET_ARN: missing SecretString");
  const parsed = JSON.parse(res.SecretString) as Record<string, unknown>;
  const { username, password } = parsed;
  if (typeof username !== "string" || !username) {
    throw new Error("DATABASE_SECRET_ARN payload missing username");
  }
  if (typeof password !== "string" || !password) {
    throw new Error("DATABASE_SECRET_ARN payload missing password");
  }
  return { username, password };
}

/** Lazily create (or reuse) the postgres.js connection. */
export async function getSql(): Promise<postgres.Sql> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const creds = await resolveCredentials();
      _sql = postgres({
        host: DATABASE_HOST,
        port: DATABASE_PORT,
        database: DATABASE_NAME,
        username: creds.username,
        password: creds.password,
        ssl: "require",
        max: 2,
        idle_timeout: 20,
        connect_timeout: 10,
      });
      return _sql;
    })();
  }
  return _initPromise;
}

export async function closeSql(): Promise<void> {
  // Clear the singleton BEFORE awaiting end() — if teardown itself throws, a
  // warm re-invocation must build a fresh connection, not reuse a defunct one.
  const sql = _sql;
  _sql = null;
  _initPromise = null;
  if (sql) {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Read a single settings-table value directly (the Lambda cannot import
 * @/lib/settings-manager). Returns null when the key is absent or blank.
 */
export async function getSettingValue(sql: postgres.Sql, key: string): Promise<string | null> {
  const rows = await sql<{ value: string | null }[]>`
    SELECT value FROM settings WHERE key = ${key} LIMIT 1
  `;
  const value = rows[0]?.value;
  return value && value.trim() ? value.trim() : null;
}

/** Read the active selection rules (picks ∪ prefixes). */
export async function listActiveRules(
  sql: postgres.Sql
): Promise<{ ruleType: "pick" | "prefix"; value: string; isActive: boolean }[]> {
  const rows = await sql<{ rule_type: "pick" | "prefix"; value: string }[]>`
    SELECT rule_type, value FROM group_selection_rules WHERE is_active = true
  `;
  return rows.map((r) => ({ ruleType: r.rule_type, value: r.value, isActive: true }));
}

/**
 * Upsert a group row (case-insensitive on group_email), refreshing name/source
 * and re-activating it. Returns the group id. Never resets last_synced_at —
 * that is owned by markSynced so a failed fetch preserves the last good time.
 */
export async function upsertGroup(
  sql: postgres.Sql,
  input: { groupEmail: string; name: string | null; source: GroupSource }
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO groups (group_email, name, source, is_active)
    VALUES (${input.groupEmail}, ${input.name}, ${input.source}, true)
    ON CONFLICT (lower(group_email)) DO UPDATE
      SET name = EXCLUDED.name,
          source = EXCLUDED.source,
          is_active = true
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Rows per bulk-insert statement. 2 bind params per row against PostgreSQL's
 * 65,535 wire-protocol parameter limit — 5,000 keeps a district-wide group
 * (e.g. all-staff@) well clear of the cap while staying in one transaction.
 */
const MEMBER_INSERT_CHUNK_SIZE = 5000;

/**
 * Full-replace a group's membership inside a transaction: delete every existing
 * row for the group, then bulk-insert the normalized set (chunked — see
 * MEMBER_INSERT_CHUNK_SIZE). Atomic — a reader never sees a partially-rebuilt
 * group.
 */
export async function replaceMembers(
  sql: postgres.Sql,
  groupId: string,
  memberEmails: string[]
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM group_members WHERE group_id = ${groupId}`;
    for (let i = 0; i < memberEmails.length; i += MEMBER_INSERT_CHUNK_SIZE) {
      const values = memberEmails
        .slice(i, i + MEMBER_INSERT_CHUNK_SIZE)
        .map((email) => ({ group_id: groupId, member_email: email }));
      await tx`INSERT INTO group_members ${tx(values, "group_id", "member_email")}`;
    }
  });
}

export async function markSynced(sql: postgres.Sql, groupId: string): Promise<void> {
  await sql`
    UPDATE groups SET last_synced_at = now(), last_sync_error = NULL WHERE id = ${groupId}
  `;
}

export async function markError(
  sql: postgres.Sql,
  groupId: string,
  message: string
): Promise<void> {
  await sql`UPDATE groups SET last_sync_error = ${message} WHERE id = ${groupId}`;
}

/**
 * Deactivate active groups whose (lowercased) email is not in the selected set.
 * Never deletes — membership rows survive so a group can be reactivated with its
 * last-known-good membership intact. Returns the number deactivated.
 */
export async function deactivateGroupsNotIn(
  sql: postgres.Sql,
  selectedEmails: string[]
): Promise<number> {
  const lowered = selectedEmails.map((e) => e.toLowerCase());
  const rows = await sql<{ id: string }[]>`
    UPDATE groups
       SET is_active = false
     WHERE is_active = true
       AND lower(group_email) <> ALL(${lowered}::text[])
    RETURNING id
  `;
  return rows.length;
}

export interface RoleReconcileResult {
  /** group-sync user_roles rows inserted. */
  added: number;
  /** group-sync user_roles rows removed. */
  removed: number;
  /** distinct users whose role_version was bumped. */
  usersChanged: number;
  /** True when the last-administrator guard blocked admin-role removal. */
  adminRoleProtected: boolean;
}

/**
 * Bulk managed-role reconciliation (Epic #1202, Phase 1 / #1204).
 *
 * The set-based, all-users mirror of the app's per-user reconciler
 * (lib/db/drizzle/user-roles.ts#reconcileUserManagedRoles). This Lambda cannot
 * import @/lib, so the two paths share a documented contract, NOT code (same
 * boundary that forces the duplicated sync core / normalize helpers). The
 * invariants are identical:
 *   - computed = (user, role) for every ACTIVE group→role mapping the user is a
 *     transitive member of (matched by lowercased email);
 *   - add computed roles the user lacks in ANY source, tagged 'group-sync';
 *   - remove only 'group-sync' rows no longer computed — 'manual' rows are never
 *     eligible, so a hand-assigned role always survives;
 *   - bump role_version once per changed user (no churn on a no-op).
 *
 * Runs in ONE transaction so a reader never sees a half-applied role set. The
 * computed set is materialized into an ON COMMIT DROP temp table so the add and
 * remove passes see an identical snapshot.
 */
export async function reconcileManagedRoles(
  sql: postgres.Sql
): Promise<RoleReconcileResult> {
  return sql.begin(async (tx) => {
    await tx`
      CREATE TEMP TABLE _computed_roles ON COMMIT DROP AS
      SELECT DISTINCT u.id AS user_id, grm.role_id
        FROM group_role_mappings grm
        JOIN groups g
          ON lower(g.group_email) = lower(grm.group_email)
         AND g.is_active = true
        JOIN group_members gm ON gm.group_id = g.id
        JOIN users u ON lower(u.email) = lower(gm.member_email)
    `;
    // Temp tables are invisible to autovacuum — give the planner real
    // cardinality for the NOT EXISTS anti-joins below.
    await tx`ANALYZE _computed_roles`;

    // Last-administrator lockout guard: if this pass would delete every
    // administrator grant system-wide (all admins are group-sync-sourced and
    // fell out of the computed set), protect the administrator role from THIS
    // delete entirely — there is no in-app recovery from zero admins. Mirrors
    // the per-user reconciler and the manual-path guard.
    const [adminGuard] = await tx<
      { admin_role_id: number; surviving_admins: number }[]
    >`
      SELECT r.id AS admin_role_id,
             (SELECT count(*)::int FROM user_roles ur
               WHERE ur.role_id = r.id
                 AND NOT (
                   ur.source = 'group-sync'
                   AND NOT EXISTS (
                     SELECT 1 FROM _computed_roles c
                      WHERE c.user_id = ur.user_id AND c.role_id = ur.role_id
                   )
                 )
             ) AS surviving_admins
        FROM roles r
       WHERE r.name = 'administrator'
       LIMIT 1
    `;
    const protectAdminRoleId =
      adminGuard && adminGuard.surviving_admins === 0
        ? adminGuard.admin_role_id
        : null;

    // Add computed roles the user does not already hold (any source). ON CONFLICT
    // DO NOTHING guards a race with the login-time reconciler on the unique
    // (user_id, role_id) index; RETURNING then reports only rows actually inserted.
    const added = await tx<{ user_id: number }[]>`
      INSERT INTO user_roles (user_id, role_id, source)
      SELECT c.user_id, c.role_id, 'group-sync'
        FROM _computed_roles c
       WHERE NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = c.user_id AND ur.role_id = c.role_id
       )
      ON CONFLICT (user_id, role_id) DO NOTHING
      RETURNING user_id
    `;

    // Remove group-sync rows no longer computed. Manual rows are never matched;
    // the administrator role is excluded entirely when the guard tripped.
    const removed = await tx<{ user_id: number }[]>`
      DELETE FROM user_roles ur
       WHERE ur.source = 'group-sync'
         AND NOT EXISTS (
           SELECT 1 FROM _computed_roles c
            WHERE c.user_id = ur.user_id AND c.role_id = ur.role_id
         )
         AND ur.role_id IS DISTINCT FROM ${protectAdminRoleId}
      RETURNING ur.user_id
    `;

    const changedUserIds = [
      ...new Set([
        ...added.map((r) => r.user_id),
        ...removed.map((r) => r.user_id),
      ]),
    ];

    if (changedUserIds.length > 0) {
      await tx`
        UPDATE users
           SET role_version = COALESCE(role_version, 0) + 1,
               updated_at = now()
         WHERE id = ANY(${changedUserIds}::int[])
      `;
    }

    return {
      added: added.length,
      removed: removed.length,
      usersChanged: changedUserIds.length,
      adminRoleProtected: protectAdminRoleId !== null,
    };
  });
}
