/**
 * Atrium Content Key Bootstrap — CloudFormation Custom Resource.
 *
 * Zero-touch provisioning for the psd-atrium agent credential (follow-up to
 * PR #1195). PR #1195 shipped the psd-atrium OpenClaw skill + an EMPTY
 * `psd-agent/<env>/atrium-content-api-key` secret, but a human still had to
 * (1) mint a content-scoped `sk-` key in AI Studio Settings and (2) run
 * `aws secretsmanager put-secret-value`. This custom resource removes BOTH
 * manual steps: on every `cdk deploy` it idempotently ensures the secret holds
 * a valid, active, content-scoped key owned by the migration-seeded service
 * user (migration 104, `cognito_sub = service-account:psd-atrium-agent`).
 *
 * Idempotency contract (runs on Create AND Update — the stack passes a per-deploy
 * Nonce so Update always fires, making the resource self-healing):
 *   - secret holds a valid+active key owned by the service user, whose scopes
 *     cover the required set -> NO-OP.
 *   - secret empty / malformed / points at a missing|inactive|revoked key, or
 *     the key's scopes no longer cover the required set -> MINT a fresh key,
 *     revoke any other active keys the service user owns (so exactly one active
 *     service key exists), store the plaintext in the secret.
 * Rotation = delete the secret value OR revoke/delete the api_keys row; the next
 * deploy re-mints.
 *
 * The DB stores ONLY the Argon2id hash (never the plaintext). The plaintext is
 * written to Secrets Manager and is NEVER logged. Hashing uses `hash-wasm`
 * (pure-WASM Argon2id) with the SAME parameters as the app's native `argon2`
 * loader (lib/api-keys/argon2-loader.ts) — the two produce interoperable PHC
 * strings (verified: native `argon2.verify()` accepts a hash-wasm hash), so the
 * app's `validateApiKey` authenticates the key with no code change. WASM avoids
 * shipping a native, arch-specific `.node` binary in the Lambda bundle.
 *
 * DB access is the repo's standard Aurora deploy-pipeline pattern: the RDS Data
 * API (rds-data:ExecuteStatement), same as the db-init migration Lambda.
 */

import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';

// ---------------------------------------------------------------------------
// Key format + Argon2 params — MUST match lib/api-keys/key-service.ts and
// lib/api-keys/argon2-loader.ts, or the app's validateApiKey() will reject the
// minted key.
// ---------------------------------------------------------------------------
const KEY_PREFIX = 'sk-';
const KEY_BYTES = 32; // 256-bit
const KEY_HEX_LENGTH = KEY_BYTES * 2; // 64 hex chars
const DISPLAY_PREFIX_LENGTH = 8; // first 8 hex chars stored for lookup + display
const KEY_FORMAT_REGEX = new RegExp(`^sk-[0-9a-f]{${KEY_HEX_LENGTH}}$`);
const ARGON2_MEMORY_KIB = 65536; // 64 MB
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 4;
const ARGON2_HASH_LENGTH = 32;
const ARGON2_SALT_BYTES = 16;

// ---------------------------------------------------------------------------
// Pure crypto helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Generate a `sk-` + 64-hex random key, identical in shape to generateApiKey. */
export function generateRawKey(): string {
  return `${KEY_PREFIX}${crypto.randomBytes(KEY_BYTES).toString('hex')}`;
}

/** First 8 hex chars after the `sk-` prefix — the indexed lookup handle. */
export function keyPrefixOf(rawKey: string): string {
  return rawKey.slice(KEY_PREFIX.length, KEY_PREFIX.length + DISPLAY_PREFIX_LENGTH);
}

export function isValidKeyFormat(rawKey: string): boolean {
  return typeof rawKey === 'string' && KEY_FORMAT_REGEX.test(rawKey);
}

/** Argon2id-hash a raw key into a PHC string the app's argon2.verify() accepts. */
export async function hashKey(rawKey: string): Promise<string> {
  return argon2id({
    password: rawKey,
    salt: crypto.randomBytes(ARGON2_SALT_BYTES),
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'encoded',
  });
}

/** Verify a raw key against a stored PHC hash (constant-time, in hash-wasm). */
export async function verifyKey(rawKey: string, phcHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: rawKey, hash: phcHash });
  } catch {
    return false;
  }
}

/** True iff `keyScopes` covers every scope in `required` (exact-match only). */
export function coversScopes(keyScopes: string[], required: string[]): boolean {
  const held = new Set(keyScopes);
  return required.every((s) => held.has(s));
}

// ---------------------------------------------------------------------------
// Injectable operations — the seam that makes idempotency unit-testable with
// fake SM/DB. `buildRdsOps` wires the real RDS Data API + Secrets Manager.
// ---------------------------------------------------------------------------

export interface ExistingKeyRow {
  keyHash: string;
  scopes: string[];
  isActive: boolean;
  revoked: boolean;
}

export interface ContentKeyOps {
  /** Current secret string, or null when the secret has no value yet. */
  readSecret(): Promise<string | null>;
  /** Store the raw plaintext key as the secret value. */
  writeSecret(rawKey: string): Promise<void>;
  /** Resolve the service user's numeric id by its cognito_sub sentinel, or null. */
  resolveServiceUserId(): Promise<number | null>;
  /** All api_keys rows for (prefix, userId) — usually 0 or 1. */
  keysByPrefix(prefix: string, userId: number): Promise<ExistingKeyRow[]>;
  /** Revoke every currently-active key owned by the service user. */
  revokeActiveKeys(userId: number): Promise<void>;
  /** Insert a new active api_keys row owned by the service user. */
  insertKey(row: {
    userId: number;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
  }): Promise<void>;
}

export interface EnsureConfig {
  serviceUserCognitoSub: string;
  keyName: string;
  requiredScopes: string[];
}

export type EnsureOutcome = 'noop' | 'minted';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Core idempotency logic. Returns `noop` when the secret already holds a valid,
 * active, sufficiently-scoped key owned by the service user; otherwise mints a
 * fresh key, revokes the service user's other active keys, and returns `minted`.
 *
 * NEVER logs the raw key. Throws when the service user row is missing (the
 * migration must have run first — the stack orders AgentPlatformStack after
 * DatabaseStack, so this is a genuine misconfiguration worth failing loudly on).
 */
export async function ensureContentKey(
  ops: ContentKeyOps,
  cfg: EnsureConfig,
  log: Logger
): Promise<EnsureOutcome> {
  const userId = await ops.resolveServiceUserId();
  if (userId == null) {
    throw new Error(
      `Atrium service user not found (cognito_sub=${cfg.serviceUserCognitoSub}). ` +
        `Migration 104-atrium-agent-service-user.sql must run before this bootstrap.`
    );
  }

  const current = await ops.readSecret();
  if (current && isValidKeyFormat(current)) {
    const prefix = keyPrefixOf(current);
    const candidates = await ops.keysByPrefix(prefix, userId);
    for (const row of candidates) {
      if (!row.isActive || row.revoked) continue;
      if (!coversScopes(row.scopes, cfg.requiredScopes)) continue;
      if (await verifyKey(current, row.keyHash)) {
        log.info('Atrium content key present and valid — no-op', {
          keyPrefix: `${KEY_PREFIX}${prefix}`,
        });
        return 'noop';
      }
    }
    log.warn('Secret holds a key with no matching active/scoped api_keys row — re-minting', {
      keyPrefix: `${KEY_PREFIX}${prefix}`,
    });
  } else {
    log.info('Secret empty or malformed — minting Atrium content key', {});
  }

  // Mint. Revoke the service user's other active keys FIRST so exactly one
  // active service key exists (cleans orphans left by a cleared secret).
  await ops.revokeActiveKeys(userId);

  const rawKey = generateRawKey();
  const keyPrefix = keyPrefixOf(rawKey);
  const keyHash = await hashKey(rawKey);
  await ops.insertKey({
    userId,
    name: cfg.keyName,
    keyPrefix,
    keyHash,
    scopes: cfg.requiredScopes,
  });
  await ops.writeSecret(rawKey);
  log.info('Minted Atrium content key', {
    keyPrefix: `${KEY_PREFIX}${keyPrefix}`,
    scopes: cfg.requiredScopes,
  });
  return 'minted';
}

// ---------------------------------------------------------------------------
// RDS Data API + Secrets Manager wiring (the real ops)
// ---------------------------------------------------------------------------

const rds = new RDSDataClient({});
const secrets = new SecretsManagerClient({});

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function fieldStr(field: Field | undefined): string | null {
  if (!field || field.isNull) return null;
  return field.stringValue ?? null;
}

export interface RdsOpsConfig {
  clusterArn: string;
  secretArn: string;
  database: string;
  contentKeySecretId: string;
  serviceUserCognitoSub: string;
}

export function buildRdsOps(cfg: RdsOpsConfig): ContentKeyOps {
  const exec = async (sql: string, parameters?: SqlParameter[]) =>
    rds.send(
      new ExecuteStatementCommand({
        resourceArn: cfg.clusterArn,
        secretArn: cfg.secretArn,
        database: cfg.database,
        sql,
        parameters,
        includeResultMetadata: true,
      })
    );

  return {
    async readSecret() {
      try {
        const resp = await secrets.send(
          new GetSecretValueCommand({ SecretId: cfg.contentKeySecretId })
        );
        const value = resp.SecretString?.trim();
        return value && value.length > 0 ? value : null;
      } catch (err) {
        // A secret created by CDK with no value has no version -> ResourceNotFound.
        // Treat as empty; any other error propagates (fail the deploy loudly).
        if ((err as { name?: string })?.name === 'ResourceNotFoundException') {
          return null;
        }
        throw err;
      }
    },

    async writeSecret(rawKey: string) {
      await secrets.send(
        new PutSecretValueCommand({
          SecretId: cfg.contentKeySecretId,
          SecretString: rawKey,
        })
      );
    },

    async resolveServiceUserId() {
      const resp = await exec(
        `SELECT id FROM users WHERE cognito_sub = :sub LIMIT 1`,
        [strParam('sub', cfg.serviceUserCognitoSub)]
      );
      const rec = resp.records?.[0];
      const id = rec?.[0]?.longValue;
      return typeof id === 'number' ? id : null;
    },

    async keysByPrefix(prefix: string, userId: number) {
      const resp = await exec(
        `SELECT key_hash, scopes, is_active, revoked_at
           FROM api_keys
          WHERE key_prefix = :prefix AND user_id = :uid`,
        [
          strParam('prefix', prefix),
          { name: 'uid', value: { longValue: userId } },
        ]
      );
      return (resp.records ?? []).map((rec) => {
        const scopesRaw = fieldStr(rec[1]);
        let scopes: string[] = [];
        if (scopesRaw) {
          try {
            const parsed = JSON.parse(scopesRaw);
            if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === 'string');
          } catch {
            scopes = [];
          }
        }
        return {
          keyHash: fieldStr(rec[0]) ?? '',
          scopes,
          isActive: rec[2]?.booleanValue === true,
          revoked: !(rec[3]?.isNull ?? true),
        };
      });
    },

    async revokeActiveKeys(userId: number) {
      await exec(
        `UPDATE api_keys
            SET is_active = false, revoked_at = now(), updated_at = now()
          WHERE user_id = :uid AND is_active = true`,
        [{ name: 'uid', value: { longValue: userId } }]
      );
    },

    async insertKey(row) {
      await exec(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes)
         VALUES (:uid, :name, :prefix, :hash, CAST(:scopes AS jsonb))`,
        [
          { name: 'uid', value: { longValue: row.userId } },
          strParam('name', row.name),
          strParam('prefix', row.keyPrefix),
          strParam('hash', row.keyHash),
          strParam('scopes', JSON.stringify(row.scopes)),
        ]
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Env + config
// ---------------------------------------------------------------------------

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

const consoleLogger: Logger = {
  info: (msg, meta) => console.info(msg, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(msg, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(msg, meta ? JSON.stringify(meta) : ''),
};

function parseScopes(raw: string): string[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new Error('KEY_SCOPES must be a non-empty JSON array of strings');
  }
  return parsed as string[];
}

// ---------------------------------------------------------------------------
// CloudFormation Custom Resource handler
// ---------------------------------------------------------------------------

export async function handler(
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> {
  console.info('event', JSON.stringify({ RequestType: event.RequestType, LogicalResourceId: event.LogicalResourceId }));

  const base = {
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  };
  const physicalId =
    'PhysicalResourceId' in event ? event.PhysicalResourceId : 'atrium-content-key-bootstrap';

  try {
    if (event.RequestType === 'Delete') {
      // Leave the key + secret in place: the secret is CDK-owned and destroyed
      // with the stack in dev; revoking here would strand the running agent if a
      // stack is merely replaced. Nothing to do.
      return { ...base, Status: 'SUCCESS', PhysicalResourceId: physicalId };
    }

    const cfg: RdsOpsConfig = {
      clusterArn: must('DB_CLUSTER_ARN'),
      secretArn: must('DB_SECRET_ARN'),
      database: must('DB_NAME'),
      contentKeySecretId: must('CONTENT_KEY_SECRET_ID'),
      serviceUserCognitoSub: must('SERVICE_USER_COGNITO_SUB'),
    };
    const requiredScopes = parseScopes(must('KEY_SCOPES'));
    const ops = buildRdsOps(cfg);

    const outcome = await ensureContentKey(
      ops,
      {
        serviceUserCognitoSub: cfg.serviceUserCognitoSub,
        keyName: process.env.KEY_NAME || 'psd-atrium agent (auto-provisioned)',
        requiredScopes,
      },
      consoleLogger
    );

    return {
      ...base,
      Status: 'SUCCESS',
      PhysicalResourceId: 'atrium-content-key-bootstrap',
      Data: { Outcome: outcome },
    };
  } catch (err) {
    console.error('atrium-content-key-bootstrap error', err instanceof Error ? err.message : String(err));
    return {
      ...base,
      Status: 'FAILED',
      Reason: err instanceof Error ? err.message : String(err),
      PhysicalResourceId: physicalId,
    };
  }
}
