/**
 * PostgreSQL integration coverage for the collection transaction boundary.
 *
 * CI environments without PostgreSQL skip this suite. Run it locally with:
 * ONEROSTER_DB_TEST_URL=postgresql://... bun test db.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { reconcileCollection } from "./db";
import type { CollectionPullSuccess } from "./oneroster-client";

const databaseUrl = process.env.ONEROSTER_DB_TEST_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = databaseUrl
  ? postgres(databaseUrl, { max: 1 })
  : null;

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
  });

  beforeEach(async () => {
    if (!sql) return;
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
});
