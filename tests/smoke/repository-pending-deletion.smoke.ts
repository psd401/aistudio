/**
 * Real-PostgreSQL regression smoke for Issue #1474.
 *
 * It recreates migration 010's legacy repository_items CHECK in a temporary
 * table, applies migration 168, and exercises the exact repository-level and
 * item-level cancellation updates used by deletion-service.ts. The transaction
 * owns only a temporary table and leaves the target database unchanged.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' \
 *     DB_SSL=false bun run test:smoke:repository-pending-deletion
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { scriptLogger as log } from "../../scripts/db/script-logger";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "infra/database/schema/168-repository-item-cancelled-status.sql"
  ),
  "utf8"
);
const migrationStatements = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

const database = postgres(databaseUrl, {
  ssl: process.env.DB_SSL === "false" ? false : "require",
  max: 1,
});

log.section("Repository pending-deletion PostgreSQL smoke");

try {
  await database.begin(async (transaction) => {
    // postgres.js transaction objects keep the Sql tagged-template API at
    // runtime, although TransactionSql omits that call signature in its types.
    const transactionSql = transaction as unknown as postgres.Sql;

    await transactionSql`
      CREATE TEMP TABLE repository_items (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        lifecycle_status text NOT NULL DEFAULT 'active',
        processing_status text DEFAULT 'pending'
          CHECK (
            processing_status IN (
              'pending',
              'processing',
              'processing_ocr',
              'processing_embeddings',
              'completed',
              'embedded',
              'failed',
              'embedding_failed'
            )
          )
      ) ON COMMIT DROP
    `;

    await transactionSql`
      INSERT INTO repository_items (processing_status)
      VALUES ('pending'), ('processing'), ('completed')
    `;

    for (const statement of migrationStatements) {
      await transactionSql.unsafe(statement);
    }

    await transactionSql`
      UPDATE repository_items item
      SET lifecycle_status = 'deleting',
          processing_status = CASE
            WHEN item.processing_status IN ('pending', 'processing')
              THEN 'cancelled'
            ELSE item.processing_status
          END
    `;

    const repositoryRows = await transactionSql<
      { id: number; processing_status: string }[]
    >`
      SELECT id, processing_status
      FROM repository_items
      ORDER BY id
    `;
    assert.deepEqual(repositoryRows, [
      { id: 1, processing_status: "cancelled" },
      { id: 2, processing_status: "cancelled" },
      { id: 3, processing_status: "completed" },
    ]);

    const [pendingItem] = await transactionSql<{ id: number }[]>`
      INSERT INTO repository_items (processing_status)
      VALUES ('pending')
      RETURNING id
    `;
    assert.ok(pendingItem);

    await transactionSql`
      UPDATE repository_items item
      SET lifecycle_status = 'deleting',
          processing_status = CASE
            WHEN item.processing_status IN ('pending', 'processing')
              THEN 'cancelled'
            ELSE item.processing_status
          END
      WHERE item.id = ${pendingItem.id}
    `;

    const [cancelledItem] = await transactionSql<
      { processing_status: string }[]
    >`
      SELECT processing_status
      FROM repository_items
      WHERE id = ${pendingItem.id}
    `;
    assert.equal(cancelledItem?.processing_status, "cancelled");

    // Reapplying the migration must remain safe even after cancellation rows
    // exist, matching local fresh-install and failed-deploy retry behavior.
    for (const statement of migrationStatements) {
      await transactionSql.unsafe(statement);
    }

    const [constraint] = await transactionSql<
      { name: string; definition: string }[]
    >`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'repository_items'::regclass
        AND conname = 'repository_items_processing_status_check'
    `;
    assert.equal(
      constraint?.name,
      "repository_items_processing_status_check"
    );
    assert.match(constraint?.definition ?? "", /cancelled/);
  });

  log.success(
    "Pending repository/item deletion and completed-item preservation passed"
  );
} finally {
  await database.end();
}
