/**
 * PostgreSQL integration coverage for group-member user provisioning (#1860).
 *
 * CI environments without PostgreSQL skip this suite. Run it locally against a
 * throwaway database with:
 * GROUP_SYNC_DB_TEST_URL=postgresql://... bun test db.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";

const databaseUrl = process.env.GROUP_SYNC_DB_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null;

async function loadDb() {
  // db.ts resolves its Aurora env at import; the suite passes its own client.
  process.env.DATABASE_HOST ??= "integration.invalid";
  process.env.DATABASE_SECRET_ARN ??= "integration-secret";
  return import("./db");
}

describeDatabase("group-member user provisioning", () => {
  beforeAll(async () => {
    if (!sql) return;
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP TABLE IF EXISTS group_members, groups, user_roles, roles, users CASCADE;
      CREATE TABLE users (
        id serial PRIMARY KEY,
        cognito_sub varchar(255) UNIQUE,
        email varchar(255),
        first_name varchar(255),
        last_name varchar(255),
        role_version integer DEFAULT 1,
        updated_at timestamp DEFAULT now() NOT NULL
      );
      CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));
      CREATE TABLE roles (id serial PRIMARY KEY, name varchar(100) NOT NULL);
      CREATE TABLE user_roles (
        id serial PRIMARY KEY,
        user_id integer REFERENCES users(id) ON DELETE CASCADE,
        role_id integer REFERENCES roles(id),
        source varchar(20) NOT NULL DEFAULT 'manual',
        updated_at timestamptz DEFAULT now(),
        UNIQUE (user_id, role_id)
      );
      CREATE TABLE groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_email text NOT NULL,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE group_members (
        group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_email text NOT NULL
      );
      INSERT INTO roles (name) VALUES ('student'), ('Staff'), ('administrator');
    `);
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("creates a staff stub for each district member with no row, and nothing else", async () => {
    if (!sql) throw new Error("database connection was not initialized");
    const { provisionGroupMemberUsers } = await loadDb();

    await sql`
      INSERT INTO users (email, first_name, cognito_sub)
      VALUES ('Signed.In@psd401.net', 'Kept', 'sub-signed-in')
    `;
    const [active] = await sql<{ id: string }[]>`
      INSERT INTO groups (group_email, is_active) VALUES ('psd-staff@psd401.net', true) RETURNING id
    `;
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO groups (group_email, is_active) VALUES ('psd-other@psd401.net', true) RETURNING id
    `;
    const [inactive] = await sql<{ id: string }[]>`
      INSERT INTO groups (group_email, is_active) VALUES ('psd-old@psd401.net', false) RETURNING id
    `;
    await sql`
      INSERT INTO group_members (group_id, member_email) VALUES
        (${active.id}, 'new.teacher@psd401.net'),
        (${other.id}, 'new.teacher@psd401.net'),
        (${active.id}, 'signed.in@psd401.net'),
        (${active.id}, '123456@psd401.net'),
        (${active.id}, 'kid@edtools.psd401.net'),
        (${active.id}, 'vendor@example.com'),
        (${active.id}, 'evil@notpsd401.net'),
        (${inactive.id}, 'departed@psd401.net')
    `;

    const first = await provisionGroupMemberUsers(sql);
    const second = await provisionGroupMemberUsers(sql);

    const rows = await sql<
      { email: string; first_name: string | null; cognito_sub: string | null; roles: string | null }[]
    >`
      SELECT u.email, u.first_name, u.cognito_sub,
             string_agg(lower(r.name) || ':' || ur.source, ',' ORDER BY r.name) AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
       GROUP BY u.id
       ORDER BY lower(u.email)
    `;

    expect(first).toEqual({ provisioned: 1 });
    expect(second).toEqual({ provisioned: 0 });
    expect(rows).toEqual([
      { email: "new.teacher@psd401.net", first_name: null, cognito_sub: null, roles: "staff:manual" },
      { email: "Signed.In@psd401.net", first_name: "Kept", cognito_sub: "sub-signed-in", roles: null },
    ]);
  });
});
