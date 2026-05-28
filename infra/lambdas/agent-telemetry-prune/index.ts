/**
 * Agent Telemetry Retention Sweep
 *
 * Runs daily (default 04:00 UTC). Deletes rows in agent_message_content
 * and agent_tool_invocations older than RETENTION_DAYS (default 90 days)
 * to bound the privacy/disk blast radius of the deep-telemetry tables.
 *
 * The aggregated summary rows in agent_messages, agent_sessions, etc.
 * are NOT pruned by this Lambda — they're cheap and useful indefinitely.
 *
 * Env vars:
 *   DATABASE_HOST         — Aurora host
 *   DATABASE_SECRET_ARN   — Aurora credentials secret
 *   DATABASE_NAME         — Aurora database (default aistudio)
 *   DATABASE_PORT         — default 5432
 *   RETENTION_DAYS        — default 90
 *   PRUNE_BATCH           — rows to delete per statement, default 5000.
 *                            Keeps each DELETE statement under
 *                            Aurora's locking ceiling.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"
import postgres from "postgres"

const DATABASE_HOST = process.env.DATABASE_HOST || ""
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || ""
const DATABASE_NAME = process.env.DATABASE_NAME || "aistudio"
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT || "5432", 10)
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "90", 10)
const PRUNE_BATCH = parseInt(process.env.PRUNE_BATCH || "5000", 10)

const secrets = new SecretsManagerClient({})

let sqlClient: postgres.Sql | null = null
async function getSql(): Promise<postgres.Sql> {
  if (sqlClient) return sqlClient
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN }),
  )
  if (!res.SecretString) throw new Error("Database secret missing SecretString")
  const creds = JSON.parse(res.SecretString) as {
    username: string
    password: string
  }
  sqlClient = postgres({
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    database: DATABASE_NAME,
    username: creds.username,
    password: creds.password,
    ssl: "require",
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
  })
  return sqlClient
}

interface PruneResult {
  contentDeleted: number
  toolsDeleted: number
  cutoffIso: string
  retentionDays: number
  batches: number
}

/**
 * Delete in batches so a single DELETE doesn't lock huge ranges of the
 * tables. Loops until either the batch returns 0 rows or we've hit a
 * safety cap (1M rows) to avoid runaway loops.
 */
async function pruneTable(
  sql: postgres.Sql,
  table: "agent_message_content" | "agent_tool_invocations",
  cutoffIso: string,
): Promise<{ deleted: number; batches: number }> {
  let deleted = 0
  let batches = 0
  const SAFETY_CAP = 1_000_000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (deleted >= SAFETY_CAP) break
    const rows = await sql<{ id: number }[]>`
      DELETE FROM ${sql(table)}
      WHERE id IN (
        SELECT id FROM ${sql(table)}
        WHERE created_at < ${cutoffIso}::timestamptz
        LIMIT ${PRUNE_BATCH}
      )
      RETURNING id
    `
    if (rows.length === 0) break
    deleted += rows.length
    batches++
  }
  return { deleted, batches }
}

export const handler = async (): Promise<PruneResult> => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000)
  const cutoffIso = cutoff.toISOString()
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "INFO",
      logger: "agent-telemetry-prune",
      evt: "prune_start",
      cutoffIso,
      retentionDays: RETENTION_DAYS,
      batchSize: PRUNE_BATCH,
    }),
  )

  const sql = await getSql()
  const content = await pruneTable(sql, "agent_message_content", cutoffIso)
  const tools = await pruneTable(sql, "agent_tool_invocations", cutoffIso)

  const result: PruneResult = {
    contentDeleted: content.deleted,
    toolsDeleted: tools.deleted,
    cutoffIso,
    retentionDays: RETENTION_DAYS,
    batches: content.batches + tools.batches,
  }
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "INFO",
      logger: "agent-telemetry-prune",
      evt: "prune_complete",
      ...result,
    }),
  )
  return result
}
