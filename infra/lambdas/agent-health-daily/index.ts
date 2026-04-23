/**
 * Agent Health Daily Lambda
 *
 * Runs once per day. For each user in the psd-agent-users table:
 *   1. Lists their S3 workspace prefix and aggregates size + object counts
 *      plus skill-file and memory-file counts (matched by key prefix).
 *   2. Joins the most-recent message timestamp from agent_messages.
 *   3. Upserts a single row into agent_health_snapshots keyed on
 *      (snapshot_date, user_email).
 *
 * Issue #890 — Component 1 "Agent Health Metrics".
 *
 * Env vars (injected by CDK):
 *   ENVIRONMENT              — dev/staging/prod
 *   WORKSPACE_BUCKET         — S3 bucket holding per-user workspace prefixes
 *   USERS_TABLE              — DynamoDB users table name
 *   DATABASE_HOST            — Aurora endpoint
 *   DATABASE_SECRET_ARN      — Aurora credentials secret
 *   DATABASE_NAME            — Aurora DB name (default aistudio)
 *   DATABASE_PORT            — Aurora port (default 5432)
 *   ABANDONED_DAYS           — days of inactivity → abandoned=true (default 7)
 */

import {
  S3Client,
  ListObjectsV2Command,
  type _Object as S3Object,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import postgres from 'postgres';

const s3 = new S3Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || '';
const USERS_TABLE = process.env.USERS_TABLE || '';
const DATABASE_HOST = process.env.DATABASE_HOST || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT || '5432', 10);
const ABANDONED_DAYS = parseInt(process.env.ABANDONED_DAYS || '7', 10);

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta: Record<string, unknown> = {}) {
  const stream = level === 'ERROR' ? process.stderr : process.stdout;
  stream.write(
    JSON.stringify({ level, message, service: 'agent-health-daily', timestamp: new Date().toISOString(), ...meta }) + '\n'
  );
}

let sqlClient: postgres.Sql | null = null;

async function getSql(): Promise<postgres.Sql> {
  if (sqlClient) return sqlClient;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN }));
  if (!res.SecretString) throw new Error('Database secret missing SecretString');
  const creds = JSON.parse(res.SecretString) as { username: string; password: string };
  sqlClient = postgres({
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    database: DATABASE_NAME,
    username: creds.username,
    password: creds.password,
    ssl: 'require',
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return sqlClient;
}

interface UserRecord {
  email: string;
  workspacePrefix: string;
  googleIdentity?: string;
}

async function listUsers(): Promise<UserRecord[]> {
  const users: UserRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await dynamo.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        ExclusiveStartKey: lastKey,
        ProjectionExpression: 'email, workspacePrefix, googleIdentity',
      })
    );
    for (const item of res.Items ?? []) {
      if (item.email && item.workspacePrefix) {
        users.push({
          email: String(item.email),
          workspacePrefix: String(item.workspacePrefix),
          googleIdentity: item.googleIdentity ? String(item.googleIdentity) : undefined,
        });
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return users;
}

interface WorkspaceStats {
  bytes: number;
  objectCount: number;
  skillCount: number;
  memoryFileCount: number;
}

async function scanWorkspace(prefix: string): Promise<WorkspaceStats> {
  const stats: WorkspaceStats = {
    bytes: 0,
    objectCount: 0,
    skillCount: 0,
    memoryFileCount: 0,
  };
  const s3Prefix = `${prefix.replace(/\/+$/, '')}/`;
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: WORKSPACE_BUCKET,
        Prefix: s3Prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of (res.Contents ?? []) as S3Object[]) {
      if (!obj.Key) continue;
      stats.bytes += obj.Size ?? 0;
      stats.objectCount += 1;
      const relative = obj.Key.slice(s3Prefix.length);
      // skills/ holds OpenClaw skill definitions, one directory per skill.
      // Count leaf files under skills/<name>/ — approximates skill count by
      // counting distinct top-level subdirectory names. Simple heuristic:
      // count keys like skills/<x>/SKILL.md for a conservative skill count.
      if (/^skills\/[^/]+\/SKILL\.md$/i.test(relative)) {
        stats.skillCount += 1;
      }
      if (/^memory\//i.test(relative) && !relative.endsWith('/')) {
        stats.memoryFileCount += 1;
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return stats;
}

/**
 * Build a map of email → last activity date by joining agent_messages.user_id
 * back to users.email. In the agent platform, user_id is the Cognito sub
 * (UUID), not an email — the join through the users table resolves this.
 */
async function lastActivityByEmail(sql: postgres.Sql): Promise<Map<string, Date>> {
  const rows = (await sql`
    SELECT u.email, MAX(m.created_at) AS last_at
    FROM agent_messages m
    INNER JOIN users u ON u.id = m.user_id
    GROUP BY u.email
  `) as unknown as Array<{ email: string; last_at: Date | string }>;
  const map = new Map<string, Date>();
  for (const row of rows) {
    map.set(row.email.toLowerCase(), new Date(row.last_at));
  }
  return map;
}

export const handler = async (): Promise<{ processed: number; abandoned: number }> => {
  if (!WORKSPACE_BUCKET || !USERS_TABLE || !DATABASE_HOST || !DATABASE_SECRET_ARN) {
    log('ERROR', 'Missing required environment variables');
    throw new Error('Agent health Lambda misconfigured');
  }

  const sql = await getSql();
  const users = await listUsers();
  log('INFO', 'Scanning workspaces', { userCount: users.length });

  const lastActivity = await lastActivityByEmail(sql);
  const today = new Date();
  const snapshotDate = today.toISOString().slice(0, 10);

  let processed = 0;
  let abandonedCount = 0;

  for (const user of users) {
    try {
      const stats = await scanWorkspace(user.workspacePrefix);
      const last = lastActivity.get(user.email.toLowerCase()) ?? null;
      const daysInactive = last
        ? Math.floor((today.getTime() - last.getTime()) / 86400000)
        : null;
      const abandoned = daysInactive !== null && daysInactive >= ABANDONED_DAYS;
      if (abandoned) abandonedCount += 1;

      await sql`
        INSERT INTO agent_health_snapshots
          (snapshot_date, user_email, workspace_prefix, workspace_bytes,
           object_count, skill_count, memory_file_count,
           last_activity_at, days_inactive, abandoned)
        VALUES
          (${snapshotDate}, ${user.email}, ${user.workspacePrefix}, ${stats.bytes},
           ${stats.objectCount}, ${stats.skillCount}, ${stats.memoryFileCount},
           ${last}, ${daysInactive}, ${abandoned})
        ON CONFLICT (snapshot_date, user_email) DO UPDATE SET
          workspace_prefix = EXCLUDED.workspace_prefix,
          workspace_bytes = EXCLUDED.workspace_bytes,
          object_count = EXCLUDED.object_count,
          skill_count = EXCLUDED.skill_count,
          memory_file_count = EXCLUDED.memory_file_count,
          last_activity_at = EXCLUDED.last_activity_at,
          days_inactive = EXCLUDED.days_inactive,
          abandoned = EXCLUDED.abandoned
      `;
      processed += 1;
    } catch (err) {
      log('ERROR', 'Failed to snapshot user workspace', {
        email: user.email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log('INFO', 'Health snapshot complete', { processed, abandonedCount, snapshotDate });
  return { processed, abandoned: abandonedCount };
};
