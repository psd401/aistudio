/**
 * Database client for embedding-generator Lambda.
 *
 * Resolves Aurora credentials from Secrets Manager at cold start,
 * then initialises a postgres.js + Drizzle instance.
 *
 * Follows the pattern established in agent-health-daily and agent-workspace-nonce-cleanup.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const secretsClient = new SecretsManagerClient({});

const DATABASE_HOST = process.env.DATABASE_HOST;
if (!DATABASE_HOST) throw new Error('DATABASE_HOST env var is required');
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN;
if (!DATABASE_SECRET_ARN) throw new Error('DATABASE_SECRET_ARN env var is required');
const DATABASE_NAME = process.env.DATABASE_NAME ?? 'aistudio';
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT ?? '5432', 10);

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let _client: postgres.Sql | null = null;
let _db: DrizzleClient | null = null;
// Prevents concurrent cold-start callers from each racing through resolveCredentials().
let _initPromise: Promise<DrizzleClient> | null = null;

async function resolveCredentials(): Promise<{ username: string; password: string }> {
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN })
  );
  if (!res.SecretString) throw new Error('DATABASE_SECRET_ARN: missing SecretString');
  const parsed = JSON.parse(res.SecretString) as Record<string, unknown>;
  const { username, password } = parsed;
  if (typeof username !== 'string' || !username) {
    throw new Error('DATABASE_SECRET_ARN payload missing username');
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('DATABASE_SECRET_ARN payload missing password');
  }
  return { username, password };
}

export async function getDb(): Promise<DrizzleClient> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const creds = await resolveCredentials();
      _client = postgres({
        host: DATABASE_HOST,
        port: DATABASE_PORT,
        database: DATABASE_NAME,
        username: creds.username,
        password: creds.password,
        ssl: 'require',
        max: 1, // SQS batchSize=1, one record per invocation
        idle_timeout: 20,
        connect_timeout: 10,
      });
      _db = drizzle(_client, { schema });
      return _db;
    })();
  }
  return _initPromise;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
    _initPromise = null; // reset so the next warm invocation re-initialises cleanly
  }
}
