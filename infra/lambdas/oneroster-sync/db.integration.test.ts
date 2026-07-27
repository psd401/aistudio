/**
 * PostgreSQL integration coverage for the collection transaction boundary.
 *
 * CI environments without PostgreSQL skip this suite. Run it locally with:
 * ONEROSTER_DB_TEST_URL=postgresql://... bun test db.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  reconcileCollection,
  reconcileOneRosterRoles,
  writeSyncStatus,
} from "./db";
import type { CollectionPullSuccess } from "./oneroster-client";

const databaseUrl = process.env.ONEROSTER_DB_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = databaseUrl
  ? postgres(databaseUrl, { max: 1 })
  : null;

async function reconcileGoogleGroupRoles(
  database: postgres.Sql
): Promise<{
  added: number;
  removed: number;
  usersChanged: number;
  adminRoleProtected: boolean;
}> {
  process.env.DATABASE_HOST ??= "integration.invalid";
  process.env.DATABASE_SECRET_ARN ??= "integration-secret";
  const { reconcileManagedRoles } = await import("../group-sync/db");
  return reconcileManagedRoles(database);
}

function orgs(
  records: Array<Record<string, unknown>>
): CollectionPullSuccess {
  return {
    name: "orgs",
    records,
    permRev: "integration-rev",
    complete: true,
  };
}

describeDatabase("OneRoster PostgreSQL reconciliation", () => {
  beforeAll(async () => {
    if (!sql) return;
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS users (
        id serial PRIMARY KEY,
        email varchar(255),
        role_version integer DEFAULT 1,
        updated_at timestamp DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roles (
        id serial PRIMARY KEY,
        name varchar(100) NOT NULL,
        description text,
        is_system boolean DEFAULT false,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        id serial PRIMARY KEY,
        user_id integer,
        role_id integer,
        source varchar(20) NOT NULL DEFAULT 'manual',
        created_at timestamp DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        UNIQUE (user_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        id serial PRIMARY KEY,
        key varchar(255) NOT NULL UNIQUE,
        value text,
        description text,
        category varchar(100),
        is_secret boolean DEFAULT false,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_email text NOT NULL,
        name text,
        source text NOT NULL DEFAULT 'manual',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_group_email
        ON groups (lower(group_email));
      CREATE TABLE IF NOT EXISTS group_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_email text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS group_role_mappings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_email text NOT NULL,
        role_id integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    const migrationUrl = new URL(
      "../../database/schema/141-oneroster-core.sql",
      import.meta.url
    );
    await sql.unsafe(readFileSync(migrationUrl, "utf8"));
    const roleSourceMigrationUrl = new URL(
      "../../database/schema/156-oneroster-user-role-source.sql",
      import.meta.url
    );
    await sql.unsafe(readFileSync(roleSourceMigrationUrl, "utf8"));
  });

  beforeEach(async () => {
    if (!sql) return;
    await sql`
      DELETE FROM group_role_mappings
       WHERE lower(group_email) LIKE ${"%@oneroster-role.test"}
    `;
    await sql`
      DELETE FROM groups
       WHERE lower(group_email) LIKE ${"%@oneroster-role.test"}
    `;
    await sql.unsafe(`
      TRUNCATE TABLE
        oneroster_enrollments,
        oneroster_user_roles,
        oneroster_users,
        oneroster_class_terms,
        oneroster_classes,
        oneroster_courses,
        oneroster_academic_sessions,
        oneroster_orgs
    `);
    await sql`
      DELETE FROM settings WHERE key = 'ONEROSTER_SYNC_STATUS'
    `;
    await sql`
      DELETE FROM user_roles
       WHERE user_id IN (
         SELECT id
           FROM users
          WHERE lower(email) LIKE ${"%@oneroster-role.test"}
       )
    `;
    await sql`
      DELETE FROM users
       WHERE lower(email) LIKE ${"%@oneroster-role.test"}
    `;
    for (const roleName of ["student", "staff", "administrator"]) {
      await sql`
        INSERT INTO roles (name, description, is_system)
        SELECT ${roleName}, ${`Integration ${roleName}`}, true
         WHERE NOT EXISTS (
           SELECT 1 FROM roles WHERE lower(name) = lower(${roleName})
         )
      `;
    }
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("upserts changed fields and deactivates only rows absent from a complete snapshot", async () => {
    if (!sql) throw new Error("database connection was not initialized");
    await reconcileCollection(
      sql,
      orgs([
        { sourcedId: "org-1", name: "Original" },
        { sourcedId: "org-2", name: "Will be absent" },
      ])
    );

    const result = await reconcileCollection(
      sql,
      orgs([{ sourcedId: "org-1", name: "Changed" }])
    );
    const rows = await sql<
      Array<{ sourced_id: string; name: string; is_active: boolean }>
    >`
      SELECT sourced_id, name, is_active
        FROM oneroster_orgs
       ORDER BY sourced_id
    `;

    expect(result).toEqual({ synced: 1, deactivated: 1 });
    expect(rows).toEqual([
      { sourced_id: "org-1", name: "Changed", is_active: true },
      { sourced_id: "org-2", name: "Will be absent", is_active: false },
    ]);
  });

  it("rolls back both upserts and absence deactivation when a collection write fails", async () => {
    if (!sql) throw new Error("database connection was not initialized");
    await reconcileCollection(
      sql,
      orgs([
        { sourcedId: "org-1", name: "Last known good" },
        { sourcedId: "org-2", name: "Still active" },
      ])
    );

    await expect(
      reconcileCollection(
        sql,
        orgs([
          { sourcedId: "org-1", name: "First duplicate" },
          { sourcedId: "org-1", name: "Second duplicate" },
        ])
      )
    ).rejects.toThrow();
    const rows = await sql<
      Array<{ sourced_id: string; name: string; is_active: boolean }>
    >`
      SELECT sourced_id, name, is_active
        FROM oneroster_orgs
       ORDER BY sourced_id
    `;

    expect(rows).toEqual([
      { sourced_id: "org-1", name: "Last known good", is_active: true },
      { sourced_id: "org-2", name: "Still active", is_active: true },
    ]);
  });

  it("persists explicit to-be-deleted state and insert sync timestamps", async () => {
    if (!sql) throw new Error("database connection was not initialized");
    await reconcileCollection(
      sql,
      orgs([{ sourcedId: "org-1", name: "Active" }])
    );
    const result = await reconcileCollection(
      sql,
      orgs([
        {
          sourcedId: "org-1",
          name: "Deleted",
          status: "to-be-deleted",
        },
      ])
    );
    const [row] = await sql<
      Array<{
        status: string;
        is_active: boolean;
        last_synced_at: Date | null;
      }>
    >`
      SELECT status, is_active, last_synced_at
        FROM oneroster_orgs
       WHERE sourced_id = 'org-1'
    `;

    expect(result.deactivated).toBe(1);
    expect(row).toEqual(
      expect.objectContaining({
        status: "tobedeleted",
        is_active: false,
        last_synced_at: expect.any(Date),
      })
    );
  });

  it("upserts the durable administrator sync status without marking it secret", async () => {
    if (!sql) throw new Error("database connection was not initialized");
    const status = {
      runId: "integration-run",
      trigger: "manual",
      state: "succeeded",
      startedAt: "2026-07-26T18:00:00.000Z",
      completedAt: "2026-07-26T18:01:00.000Z",
      unchanged: false,
      collections: [],
      error: null,
    };

    await writeSyncStatus(sql, status);
    const [row] = await sql<
      Array<{
        value: string;
        category: string | null;
        is_secret: boolean | null;
      }>
    >`
      SELECT value, category, is_secret
        FROM settings
       WHERE key = 'ONEROSTER_SYNC_STATUS'
    `;

    expect(JSON.parse(row.value)).toEqual(status);
    expect(row.category).toBe("integrations");
    expect(row.is_secret).toBe(false);
  });

  it("reconciles lowercased roles and transfers overlapping provider ownership atomically", async () => {
    if (!sql) throw new Error("database connection was not initialized");
    const roleRows = await sql<Array<{ id: number; name: string }>>`
      SELECT id, lower(name) AS name
        FROM roles
       WHERE lower(name) = ANY(${["student", "staff", "administrator"]}::text[])
    `;
    const roleIds = new Map(roleRows.map((role) => [role.name, role.id]));
    const studentRoleId = roleIds.get("student");
    const staffRoleId = roleIds.get("staff");
    const administratorRoleId = roleIds.get("administrator");
    if (!studentRoleId || !staffRoleId || !administratorRoleId) {
      throw new Error("required integration roles were not initialized");
    }

    const [mixedCaseUser] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email, role_version)
      VALUES ('Mixed.Case@ONEROSTER-ROLE.TEST', 10)
      RETURNING id
    `;
    const [staffUser] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email, role_version)
      VALUES ('staff@oneroster-role.test', 20)
      RETURNING id
    `;
    const [removedUser] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email, role_version)
      VALUES ('removed@oneroster-role.test', 30)
      RETURNING id
    `;
    const [unchangedUser] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email, role_version)
      VALUES ('unchanged@oneroster-role.test', 40)
      RETURNING id
    `;
    const [protectedAdminUser] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email, role_version)
      VALUES ('protected-admin@oneroster-role.test', 50)
      RETURNING id
    `;

    await sql`
      INSERT INTO user_roles (user_id, role_id, source)
      VALUES
        (${mixedCaseUser.id}, ${administratorRoleId}, 'manual'),
        (${mixedCaseUser.id}, ${staffRoleId}, 'group-sync'),
        (${staffUser.id}, ${studentRoleId}, 'oneroster'),
        (${removedUser.id}, ${staffRoleId}, 'oneroster'),
        (${unchangedUser.id}, ${studentRoleId}, 'oneroster'),
        (${protectedAdminUser.id}, ${administratorRoleId}, 'oneroster')
    `;
    await sql`
      INSERT INTO oneroster_users (
        sourced_id,
        email,
        enabled_user,
        status,
        is_active
      )
      VALUES
        ('roster-mixed', 'mixed.case@oneroster-role.test', true, 'active', true),
        ('roster-staff', 'staff@oneroster-role.test', true, 'active', true),
        ('roster-unchanged', 'unchanged@oneroster-role.test', true, 'active', true),
        ('roster-unmatched', 'not-signed-in@oneroster-role.test', true, 'active', true)
    `;
    await sql`
      INSERT INTO oneroster_user_roles (
        user_sourced_id,
        role,
        role_type,
        status,
        is_active
      )
      VALUES
        ('roster-mixed', 'student', 'primary', 'active', true),
        ('roster-mixed', 'teacher', 'secondary', 'active', true),
        ('roster-staff', 'administrator', 'primary', 'active', true),
        ('roster-unchanged', 'student', 'primary', 'active', true),
        ('roster-unmatched', 'teacher', 'primary', 'active', true)
    `;
    const [studentGroup] = await sql<Array<{ id: string }>>`
      INSERT INTO groups (
        group_email,
        name,
        source,
        is_active
      )
      VALUES (
        'roster-student@oneroster-role.test',
        'Roster overlap student group',
        'manual',
        true
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO group_members (group_id, member_email)
      VALUES (${studentGroup.id}, 'staff@oneroster-role.test')
    `;
    await sql`
      INSERT INTO group_role_mappings (group_email, role_id)
      VALUES ('roster-student@oneroster-role.test', ${studentRoleId})
    `;

    const result = await reconcileOneRosterRoles(sql);
    const groupResult = await reconcileGoogleGroupRoles(sql);
    const grants = await sql<
      Array<{ email: string; role: string; source: string }>
    >`
      SELECT lower(application_user.email) AS email,
             lower(application_role.name) AS role,
             managed.source
        FROM user_roles managed
        JOIN users application_user ON application_user.id = managed.user_id
        JOIN roles application_role ON application_role.id = managed.role_id
       WHERE lower(application_user.email) LIKE ${"%@oneroster-role.test"}
       ORDER BY email, role
    `;
    const versions = await sql<Array<{ email: string; role_version: number }>>`
      SELECT lower(email) AS email, role_version
        FROM users
       WHERE lower(email) LIKE ${"%@oneroster-role.test"}
       ORDER BY email
    `;

    expect(result).toEqual({ granted: 2, revoked: 1, usersChanged: 3 });
    expect(groupResult).toEqual({
      added: 0,
      removed: 0,
      usersChanged: 0,
      adminRoleProtected: false,
    });
    expect(grants).toEqual([
      {
        email: "mixed.case@oneroster-role.test",
        role: "administrator",
        source: "manual",
      },
      {
        email: "mixed.case@oneroster-role.test",
        role: "staff",
        source: "oneroster",
      },
      {
        email: "mixed.case@oneroster-role.test",
        role: "student",
        source: "oneroster",
      },
      {
        email: "protected-admin@oneroster-role.test",
        role: "administrator",
        source: "oneroster",
      },
      {
        email: "staff@oneroster-role.test",
        role: "staff",
        source: "oneroster",
      },
      {
        email: "staff@oneroster-role.test",
        role: "student",
        source: "group-sync",
      },
      {
        email: "unchanged@oneroster-role.test",
        role: "student",
        source: "oneroster",
      },
    ]);
    expect(versions).toEqual([
      { email: "mixed.case@oneroster-role.test", role_version: 11 },
      { email: "protected-admin@oneroster-role.test", role_version: 50 },
      { email: "removed@oneroster-role.test", role_version: 31 },
      { email: "staff@oneroster-role.test", role_version: 21 },
      { email: "unchanged@oneroster-role.test", role_version: 40 },
    ]);
  });
});
