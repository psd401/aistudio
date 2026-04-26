/**
 * Agent Workspace Nonce Cleanup Lambda
 *
 * Runs once per day. Deletes consent nonces older than RETENTION_DAYS from
 * `psd_agent_workspace_consent_nonces`. Without this, the table grows
 * unbounded — every successful consent burns one row, and abandoned consent
 * attempts (user clicked the link, never completed OAuth) never get cleaned.
 *
 * The `idx_agent_workspace_nonces_cleanup` index on `created_at` makes the
 * range delete efficient. We also batch in chunks so a backlog doesn't
 * cause a single statement to lock the table for an extended window.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration.
 *
 * Env vars (injected by CDK):
 *   ENVIRONMENT         — dev/staging/prod (informational)
 *   DATABASE_HOST       — Aurora endpoint
 *   DATABASE_SECRET_ARN — Aurora credentials secret (postgres user/pass)
 *   DATABASE_NAME       — Aurora DB name (default aistudio)
 *   DATABASE_PORT       — Aurora port (default 5432)
 *   RETENTION_DAYS      — keep nonces this long (default 7)
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import postgres from 'postgres';

const sm = new SecretsManagerClient({});

interface DbCredentials {
  username: string;
  password: string;
}

async function getDbCredentials(secretArn: string): Promise<DbCredentials> {
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!resp.SecretString) {
    throw new Error('DATABASE_SECRET_ARN returned no SecretString');
  }
  const parsed = JSON.parse(resp.SecretString) as Record<string, unknown>;
  const username = parsed.username as string | undefined;
  const password = parsed.password as string | undefined;
  if (!username || !password) {
    throw new Error('DATABASE_SECRET_ARN payload missing username/password');
  }
  return { username, password };
}

export async function handler(): Promise<{
  status: 'ok' | 'error';
  deleted: number;
  retentionDays: number;
}> {
  const retentionDays = Number(process.env.RETENTION_DAYS ?? '7');
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`RETENTION_DAYS must be a positive integer, got: ${process.env.RETENTION_DAYS}`);
  }

  const secretArn = process.env.DATABASE_SECRET_ARN;
  const host = process.env.DATABASE_HOST;
  if (!secretArn || !host) {
    throw new Error('DATABASE_SECRET_ARN and DATABASE_HOST are required');
  }

  const dbName = process.env.DATABASE_NAME ?? 'aistudio';
  const port = Number(process.env.DATABASE_PORT ?? '5432');

  const creds = await getDbCredentials(secretArn);

  const sql = postgres({
    host,
    port,
    database: dbName,
    username: creds.username,
    password: creds.password,
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    // Delete in batches of 1000 so the transaction never holds long-running
    // locks even with a large backlog. The cleanup index makes each batch
    // an indexed range scan; rows are physically gone after each commit.
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    while (true) {
      const result = await sql<{ nonce: string }[]>`
        DELETE FROM psd_agent_workspace_consent_nonces
        WHERE nonce IN (
          SELECT nonce FROM psd_agent_workspace_consent_nonces
          WHERE created_at < NOW() - (${retentionDays}::int * INTERVAL '1 day')
          ORDER BY created_at ASC
          LIMIT ${BATCH_SIZE}
        )
        RETURNING nonce
      `;

      const deleted = result.count ?? result.length;
      totalDeleted += deleted;

      if (deleted < BATCH_SIZE) break;
    }

    // CloudWatch metric via structured log line — avoids the cost and
    // permission surface of putting a real CloudWatch metric. Operators
    // can build a log-metric filter on `agent.workspace.nonces.deleted`.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      level: 'info',
      message: 'agent.workspace.nonces.deleted',
      retentionDays,
      deleted: totalDeleted,
    }));

    return { status: 'ok', deleted: totalDeleted, retentionDays };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
