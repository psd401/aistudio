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
