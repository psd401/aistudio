/**
 * Duplicate-email pre-check for migration 112 (Epic #1202, Phase 4 / #1207).
 *
 * Migration 112 adds a UNIQUE index on lower(users.email) because email is an
 * authorization join key (group membership → roles/resource grants join on it).
 * A plain CREATE UNIQUE INDEX FAILS the deploy if the database already holds two
 * rows with the same case-insensitive email — by design, so we never ship a
 * partial index that silently hides the ambiguity.
 *
 * Run this against the TARGET database BEFORE deploying migration 112:
 *   DATABASE_URL=postgres://... bun run scripts/db/report-duplicate-emails.ts
 * (local dev defaults to the docker postgres, same as run-migrations.ts).
 *
 * Exit codes:
 *   0 — no duplicates; migration 112 will apply cleanly.
 *   1 — duplicates found (details printed); remediate per the dedupe runbook in
 *       docs/features/google-group-sync.md before deploying.
 *   2 — the script itself failed (connection/query error).
 *
 * READ-ONLY: this script never writes. Dedupe (merging user rows and their FKs) is
 * a deliberate human step — see the runbook — never an automated migration.
 */

import postgres from "postgres";
import { scriptLogger as log } from "./script-logger";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";

interface DuplicateGroup {
  email: string;
  count: number;
  ids: number[];
}

async function main(): Promise<void> {
  log.section("AI Studio - Duplicate Email Pre-Check (#1207 / migration 112)");
  log.info("Database", { url: DATABASE_URL.replace(/:\/\/.*@/, "://*****@") });

  const sql = postgres(DATABASE_URL, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    // One row per case-insensitive email that appears more than once, with the
    // colliding user ids so an operator can decide which to keep/merge.
    const rows = await sql<DuplicateGroup[]>`
      SELECT lower(email) AS email,
             count(*)::int AS count,
             array_agg(id ORDER BY id) AS ids
        FROM users
       WHERE email IS NOT NULL
       GROUP BY lower(email)
      HAVING count(*) > 1
       ORDER BY count(*) DESC, lower(email)
    `;

    if (rows.length === 0) {
      log.success(
        "No duplicate emails — migration 112 (unique index on lower(email)) will apply cleanly."
      );
      return;
    }

    const totalRows = rows.reduce((sum, r) => sum + r.count, 0);
    log.fail(
      `${rows.length} duplicated email(s) across ${totalRows} user rows — migration 112 WILL FAIL until remediated.`
    );
    for (const r of rows) {
      log.warn("Duplicate email", { email: r.email, count: r.count, userIds: r.ids });
    }
    log.info(
      "Remediate per the dedupe runbook (docs/features/google-group-sync.md) before deploying migration 112."
    );
    // Non-zero exit so CI / an operator script can gate the deploy on this.
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  log.error("Duplicate-email pre-check failed to run", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(2);
});
