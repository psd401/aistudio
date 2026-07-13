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
 * strings, so the app's `validateApiKey` authenticates the key with no code
 * change. The cross-library claim is enforced by a unit test that verifies a
 * hash-wasm-produced hash with the app's native `argon2.verify()` (hash-wasm is
 * pinned exact so a bump can't silently change PHC encoding). WASM avoids
 * shipping a native, arch-specific `.node` binary in the Lambda bundle.
 *
 * Failure posture: a MISSING service user (migration 104 not applied yet — e.g.
 * a partial single-stack deploy against a cluster whose DatabaseStack predates
 * the migration) is reported as SUCCESS with Outcome `skipped-migration-pending`
 * plus an error log, NOT a CFN FAILED. A FAILED here rolls back the ENTIRE
 * shared AgentPlatformStack, and the CFN rollback re-invokes this handler with
 * the same inputs — which would fail again and wedge the stack in
 * UPDATE_ROLLBACK_FAILED. Skipping degrades to "key not provisioned yet"; the
 * per-deploy Nonce re-runs the bootstrap on the next (full) deploy, which
 * self-heals. Transient AWS errors still fail loudly (retry = redeploy).
 *
 * DB access is the repo's standard Aurora deploy-pipeline pattern: the RDS Data
 * API (rds-data:ExecuteStatement), same as the db-init migration Lambda. The
 * revoke-old + insert-new pair runs inside ONE Data API transaction so a crash
 * between them cannot leave the two DB states disagreeing.
 */

import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

/**
 * Return shape for the CDK `custom-resources.Provider` framework's onEvent
 * handler. The framework — NOT this Lambda — posts the CFN response: a normal
 * return means SUCCESS (only PhysicalResourceId/Data/NoEcho are read; a
 * `Status` field would be IGNORED), and a FAILURE is signaled by THROWING.
 */
interface ProviderOnEventResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

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
// Key identity — single source of truth (the CDK stack passes neither; a
// duplicated literal in the stack drifted from the Lambda's fallback once).
// KEY_SCOPES must stay a subset of ROLE_SCOPES.staff's content:* scopes and
// MUST NOT include content:publish_public (the §26.4 public-publish approval
// gate is deliberately human/admin-held) — enforced by a unit test against
// lib/api-keys/scopes.ts.
// ---------------------------------------------------------------------------
export const KEY_NAME = 'psd-atrium agent (auto-provisioned)';
export const KEY_SCOPES: readonly string[] = [
  'content:read',
  'content:create',
  'content:update',
  // The agent may clean up its OWN junk: delete is owner/admin-gated in the
  // service, so this key can only remove content the service user owns. Staying
  // tethered to ROLE_SCOPES.staff's content:* subset (minus publish_public) keeps
  // the drift-guard unit test green; the deployed key self-heals to this scope set
  // on the next deploy via the scope-drift re-mint.
  'content:delete',
  'content:publish_internal',
];

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

/**
 * True iff the key's scopes are EXACTLY the required set (order-insensitive).
 * Set-equality, not subset: a live key that holds MORE than required (e.g.
 * KEY_SCOPES was narrowed in a later deploy) must also re-mint, or a
 * least-privilege reduction would never propagate to the standing credential.
 */
export function scopesMatch(keyScopes: readonly string[], required: readonly string[]): boolean {
  const held = new Set(keyScopes);
  return held.size === new Set(required).size && required.every((s) => held.has(s));
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
  /**
   * Atomically revoke every currently-active key owned by the service user AND
   * insert the new active row — ONE transaction, so a crash between the two
   * cannot leave the service user with zero (or two) active keys recorded.
   */
  replaceActiveKey(row: {
    userId: number;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: readonly string[];
  }): Promise<void>;
}

export interface EnsureConfig {
  serviceUserCognitoSub: string;
  keyName: string;
  requiredScopes: readonly string[];
}

export type EnsureOutcome = 'noop' | 'minted' | 'skipped-migration-pending';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Core idempotency logic. Returns `noop` when the secret already holds a valid,
 * active key owned by the service user whose scopes EXACTLY match the required
 * set; otherwise mints a fresh key (revoke-old + insert-new in one transaction
 * via `ops.replaceActiveKey`) and returns `minted`.
 *
 * NEVER logs the raw key. A missing service user row (migration 104 not applied
 * to this cluster yet) returns `skipped-migration-pending` with an error log
 * instead of throwing: a throw here becomes a CFN FAILED that rolls back — and
 * can wedge — the entire shared AgentPlatformStack, whereas skipping degrades to
 * "key not provisioned yet" and self-heals on the next full deploy (the Nonce
 * re-fires this handler every deploy).
 */
export async function ensureContentKey(
  ops: ContentKeyOps,
  cfg: EnsureConfig,
  log: Logger
): Promise<EnsureOutcome> {
  const userId = await ops.resolveServiceUserId();
  if (userId == null) {
    log.error(
      'Atrium service user not found — skipping key provisioning (self-heals on the next full deploy)',
      {
        cognitoSub: cfg.serviceUserCognitoSub,
        remediation:
          'Deploy AIStudio-DatabaseStack first (migration 104-atrium-agent-service-user.sql), then redeploy this stack — use the canonical full deploy, never a partial one.',
      }
    );
    return 'skipped-migration-pending';
  }

  const current = await ops.readSecret();
  if (current && isValidKeyFormat(current)) {
    const prefix = keyPrefixOf(current);
    const candidates = await ops.keysByPrefix(prefix, userId);
    for (const row of candidates) {
      if (!row.isActive || row.revoked) continue;
      if (!scopesMatch(row.scopes, cfg.requiredScopes)) continue;
      if (await verifyKey(current, row.keyHash)) {
        log.info('Atrium content key present and valid — no-op', {
          keyPrefix: `${KEY_PREFIX}${prefix}`,
        });
        return 'noop';
      }
    }
    log.warn('Secret holds a key with no matching active/exactly-scoped api_keys row — re-minting', {
      keyPrefix: `${KEY_PREFIX}${prefix}`,
    });
  } else {
    log.info('Secret empty or malformed — minting Atrium content key', {});
  }

  // Mint: revoke-old + insert-new atomically (exactly one active service key),
  // then persist the plaintext. If the secret write fails after the DB commit,
  // the deploy fails loudly and the next run's re-mint sweeps the orphaned row.
  const rawKey = generateRawKey();
  const keyPrefix = keyPrefixOf(rawKey);
  const keyHash = await hashKey(rawKey);
  await ops.replaceActiveKey({
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
  const exec = async (sql: string, parameters?: SqlParameter[], transactionId?: string) =>
    rds.send(
      new ExecuteStatementCommand({
        resourceArn: cfg.clusterArn,
        secretArn: cfg.secretArn,
        database: cfg.database,
        sql,
        parameters,
        transactionId,
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
        if (err instanceof ResourceNotFoundException) {
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
          // RDS Data API OMITS `isNull` on non-null fields (it does not send
          // `isNull: false`), so `!(isNull ?? true)` was permanently false.
          // A non-null `revoked_at` surfaces via fieldStr's stringValue path.
          revoked: fieldStr(rec[3]) !== null,
        };
      });
    },

    async replaceActiveKey(row) {
      // Revoke-old + insert-new inside ONE Data API transaction: a crash
      // between the statements can never commit a half-replaced key state.
      const { transactionId } = await rds.send(
        new BeginTransactionCommand({
          resourceArn: cfg.clusterArn,
          secretArn: cfg.secretArn,
          database: cfg.database,
        })
      );
      if (!transactionId) throw new Error('RDS Data API returned no transactionId');
      try {
        await exec(
          `UPDATE api_keys
              SET is_active = false, revoked_at = now(), updated_at = now()
            WHERE user_id = :uid AND is_active = true`,
          [{ name: 'uid', value: { longValue: row.userId } }],
          transactionId
        );
        await exec(
          `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes)
           VALUES (:uid, :name, :prefix, :hash, CAST(:scopes AS jsonb))`,
          [
            { name: 'uid', value: { longValue: row.userId } },
            strParam('name', row.name),
            strParam('prefix', row.keyPrefix),
            strParam('hash', row.keyHash),
            strParam('scopes', JSON.stringify(row.scopes)),
          ],
          transactionId
        );
        await rds.send(
          new CommitTransactionCommand({
            resourceArn: cfg.clusterArn,
            secretArn: cfg.secretArn,
            transactionId,
          })
        );
      } catch (err) {
        try {
          await rds.send(
            new RollbackTransactionCommand({
              resourceArn: cfg.clusterArn,
              secretArn: cfg.secretArn,
              transactionId,
            })
          );
        } catch {
          // Rollback is best-effort; the Data API expires abandoned txns itself.
        }
        throw err;
      }
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

// ---------------------------------------------------------------------------
// CloudFormation Custom Resource handler
// ---------------------------------------------------------------------------

export async function handler(
  event: CloudFormationCustomResourceEvent
): Promise<ProviderOnEventResponse> {
  console.info('event', JSON.stringify({ RequestType: event.RequestType, LogicalResourceId: event.LogicalResourceId }));

  const physicalId =
    'PhysicalResourceId' in event ? event.PhysicalResourceId : 'atrium-content-key-bootstrap';

  try {
    if (event.RequestType === 'Delete') {
      // Leave the key + secret in place: the secret is CDK-owned and destroyed
      // with the stack in dev; revoking here would strand the running agent if a
      // stack is merely replaced. Nothing to do.
      return { PhysicalResourceId: physicalId };
    }

    const cfg: RdsOpsConfig = {
      clusterArn: must('DB_CLUSTER_ARN'),
      secretArn: must('DB_SECRET_ARN'),
      database: must('DB_NAME'),
      contentKeySecretId: must('CONTENT_KEY_SECRET_ID'),
      serviceUserCognitoSub: must('SERVICE_USER_COGNITO_SUB'),
    };
    const ops = buildRdsOps(cfg);

    const outcome = await ensureContentKey(
      ops,
      {
        serviceUserCognitoSub: cfg.serviceUserCognitoSub,
        keyName: KEY_NAME,
        requiredScopes: KEY_SCOPES,
      },
      consoleLogger
    );

    return { PhysicalResourceId: physicalId, Data: { Outcome: outcome } };
  } catch (err) {
    // The Provider framework signals CFN failure ONLY via a throw — a returned
    // `Status: 'FAILED'` object would be read as SUCCESS and silently swallow
    // the error. Log for CloudWatch, then rethrow so the deploy fails loudly.
    console.error('atrium-content-key-bootstrap error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}
