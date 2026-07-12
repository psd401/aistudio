/**
 * Unit tests for the atrium-content-key-bootstrap custom resource.
 *
 * Covers the idempotency contract with an in-memory fake of the SM/DB ops:
 *   - empty secret                      -> MINT
 *   - valid existing key                -> NO-OP
 *   - stale/orphaned secret             -> RE-MINT
 *   - scope drift (missing OR extra)    -> RE-MINT (exact-match semantics)
 *   - inactive and/or revoked key       -> RE-MINT (each condition isolated)
 *   - missing service user              -> SUCCESS, skipped-migration-pending
 * plus:
 *   - the CROSS-LIBRARY Argon2 interop: the app's native `argon2` (the exact
 *     dependency lib/api-keys/argon2-loader.ts loads) must verify a
 *     hash-wasm-produced PHC string (adversarial review P1 — previously only
 *     claimed in a comment, never tested)
 *   - KEY_SCOPES tethered to lib/api-keys/scopes.ts ROLE_SCOPES.staff and
 *     excluding content:publish_public (security review P2 — drift guard)
 *   - buildRdsOps field parsing against realistic RDS Data API shapes,
 *     including the revoked_at tagged-union case where `isNull` is OMITTED on
 *     non-null fields (the shape that exposed the revoked-inversion bug)
 *   - the CloudFormation handler's routing: Delete no-op, Create/Update mint,
 *     skipped-migration-pending passthrough, FAILED on missing env
 *
 * Runs under the "lambdas" project in infra/jest.config.js. Requires a local
 * `bun install` in this lambda dir (hash-wasm + @aws-sdk/* resolvable).
 */
import {
  ensureContentKey,
  generateRawKey,
  keyPrefixOf,
  isValidKeyFormat,
  hashKey,
  verifyKey,
  scopesMatch,
  buildRdsOps,
  handler,
  KEY_SCOPES,
  KEY_NAME,
  type ContentKeyOps,
  type ExistingKeyRow,
  type EnsureConfig,
  type Logger,
} from '../index';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  SecretsManagerClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
// The app's REAL scope registry — the single source of truth the minted key's
// scopes must stay tethered to (relative import; scopes.ts is dependency-free).
import { ROLE_SCOPES } from '../../../../lib/api-keys/scopes';

const REQUIRED_SCOPES = [...KEY_SCOPES];

const CFG: EnsureConfig = {
  serviceUserCognitoSub: 'service-account:psd-atrium-agent',
  keyName: KEY_NAME,
  requiredScopes: REQUIRED_SCOPES,
};

const SERVICE_USER_ID = 3;

interface FakeState {
  secret: string | null;
  userId: number | null;
  keys: Array<{ userId: number; keyPrefix: string } & ExistingKeyRow>;
}

interface FakeOps extends ContentKeyOps {
  state: FakeState;
  writeSecret: jest.Mock;
  replaceActiveKey: jest.Mock;
}

function makeOps(initial: Partial<FakeState>): FakeOps {
  const state: FakeState = {
    secret: initial.secret ?? null,
    userId: initial.userId === undefined ? SERVICE_USER_ID : initial.userId,
    keys: initial.keys ?? [],
  };
  const writeSecret = jest.fn(async (rawKey: string) => {
    state.secret = rawKey;
  });
  const replaceActiveKey = jest.fn(
    async (row: { userId: number; keyPrefix: string; keyHash: string; scopes: readonly string[] }) => {
      // Mirrors the real transactional semantics: revoke-all then insert, atomically.
      for (const k of state.keys) {
        if (k.userId === row.userId && k.isActive) {
          k.isActive = false;
          k.revoked = true;
        }
      }
      state.keys.push({
        userId: row.userId,
        keyPrefix: row.keyPrefix,
        keyHash: row.keyHash,
        scopes: [...row.scopes],
        isActive: true,
        revoked: false,
      });
    }
  );
  return {
    state,
    writeSecret,
    replaceActiveKey,
    async readSecret() {
      return state.secret;
    },
    async resolveServiceUserId() {
      return state.userId;
    },
    async keysByPrefix(prefix, userId) {
      return state.keys
        .filter((k) => k.keyPrefix === prefix && k.userId === userId)
        .map(({ keyHash, scopes, isActive, revoked }) => ({ keyHash, scopes, isActive, revoked }));
    },
  };
}

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// hash-wasm Argon2id is real WASM crypto (~tens of ms). Give jest headroom.
jest.setTimeout(30_000);

describe('pure helpers', () => {
  it('generateRawKey produces sk- + 64 hex and validates', () => {
    const raw = generateRawKey();
    expect(raw).toMatch(/^sk-[0-9a-f]{64}$/);
    expect(isValidKeyFormat(raw)).toBe(true);
    expect(keyPrefixOf(raw)).toBe(raw.slice(3, 11));
  });

  it('isValidKeyFormat rejects malformed inputs', () => {
    expect(isValidKeyFormat('')).toBe(false);
    expect(isValidKeyFormat('nope')).toBe(false);
    expect(isValidKeyFormat('sk-XYZ')).toBe(false);
    expect(isValidKeyFormat('sk-' + 'a'.repeat(63))).toBe(false);
  });

  it('hashKey + verifyKey round-trip (real Argon2id PHC)', async () => {
    const raw = generateRawKey();
    const hash = await hashKey(raw);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(await verifyKey(raw, hash)).toBe(true);
    expect(await verifyKey(raw + 'x', hash)).toBe(false);
  });

  it('scopesMatch is exact set equality — subset AND superset both fail', () => {
    expect(scopesMatch(REQUIRED_SCOPES, REQUIRED_SCOPES)).toBe(true);
    expect(scopesMatch([...REQUIRED_SCOPES].reverse(), REQUIRED_SCOPES)).toBe(true);
    expect(scopesMatch(['content:read'], REQUIRED_SCOPES)).toBe(false);
    // An over-scoped key must NOT count as matching — least-privilege
    // reductions to KEY_SCOPES must trigger a re-mint.
    expect(scopesMatch([...REQUIRED_SCOPES, 'content:publish_public'], REQUIRED_SCOPES)).toBe(false);
  });
});

describe('cross-library Argon2 interop (the claim validateApiKey depends on)', () => {
  it("the app's native argon2.verify() accepts a hash-wasm PHC string", async () => {
    // The exact library lib/api-keys/argon2-loader.ts loads at runtime,
    // resolved from the repo root node_modules.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nativeArgon2 = require('argon2') as {
      verify(hash: string, plain: string): Promise<boolean>;
    };
    const raw = generateRawKey();
    const wasmHash = await hashKey(raw);
    await expect(nativeArgon2.verify(wasmHash, raw)).resolves.toBe(true);
    await expect(nativeArgon2.verify(wasmHash, raw + 'x')).resolves.toBe(false);
  });
});

describe('KEY_SCOPES drift guard (tethered to lib/api-keys/scopes.ts)', () => {
  it('exactly matches the content:* subset of ROLE_SCOPES.staff', () => {
    const staffContent = ROLE_SCOPES.staff.filter((s: string) => s.startsWith('content:') && s !== 'content:publish_public');
    expect(new Set(KEY_SCOPES)).toEqual(new Set(staffContent));
  });

  it('never includes content:publish_public (§26.4 approval gate is human/admin-held)', () => {
    expect(KEY_SCOPES).not.toContain('content:publish_public');
  });

  it('every minted scope is actually grantable to the staff role', () => {
    for (const scope of KEY_SCOPES) {
      expect(ROLE_SCOPES.staff).toContain(scope);
    }
  });
});

describe('ensureContentKey idempotency', () => {
  it('empty secret -> MINT (key stored, valid, correctly scoped)', async () => {
    const ops = makeOps({ secret: null });
    const outcome = await ensureContentKey(ops, CFG, noopLog);

    expect(outcome).toBe('minted');
    expect(ops.replaceActiveKey).toHaveBeenCalledTimes(1);
    expect(ops.writeSecret).toHaveBeenCalledTimes(1);

    // The stored secret is a valid sk- key whose hash+scopes landed in the DB.
    const stored = ops.state.secret!;
    expect(isValidKeyFormat(stored)).toBe(true);
    const row = ops.state.keys.find((k) => k.keyPrefix === keyPrefixOf(stored))!;
    expect(row).toBeDefined();
    expect(row.userId).toBe(SERVICE_USER_ID);
    expect(row.scopes).toEqual(REQUIRED_SCOPES);
    expect(row.scopes).not.toContain('content:publish_public');
    expect(await verifyKey(stored, row.keyHash)).toBe(true);
  });

  it('valid existing key -> NO-OP (no mint, no secret write)', async () => {
    const raw = generateRawKey();
    const hash = await hashKey(raw);
    const ops = makeOps({
      secret: raw,
      keys: [
        {
          userId: SERVICE_USER_ID,
          keyPrefix: keyPrefixOf(raw),
          keyHash: hash,
          scopes: REQUIRED_SCOPES,
          isActive: true,
          revoked: false,
        },
      ],
    });

    const outcome = await ensureContentKey(ops, CFG, noopLog);

    expect(outcome).toBe('noop');
    expect(ops.replaceActiveKey).not.toHaveBeenCalled();
    expect(ops.writeSecret).not.toHaveBeenCalled();
    expect(ops.state.secret).toBe(raw);
  });

  it('stale/orphaned secret (no matching active row) -> RE-MINT', async () => {
    const orphan = generateRawKey();
    const ops = makeOps({ secret: orphan, keys: [] });

    const outcome = await ensureContentKey(ops, CFG, noopLog);

    expect(outcome).toBe('minted');
    expect(ops.replaceActiveKey).toHaveBeenCalledTimes(1);
    const stored = ops.state.secret!;
    expect(stored).not.toBe(orphan);
    expect(isValidKeyFormat(stored)).toBe(true);
  });

  it('scope drift (row missing a required scope) -> RE-MINT', async () => {
    const raw = generateRawKey();
    const hash = await hashKey(raw);
    const ops = makeOps({
      secret: raw,
      keys: [
        {
          userId: SERVICE_USER_ID,
          keyPrefix: keyPrefixOf(raw),
          keyHash: hash,
          scopes: ['content:read', 'content:create'], // missing update + publish_internal
          isActive: true,
          revoked: false,
        },
      ],
    });

    const outcome = await ensureContentKey(ops, CFG, noopLog);
    expect(outcome).toBe('minted');
    expect(ops.state.secret).not.toBe(raw);
  });

  it('scope drift (row holds an EXTRA scope) -> RE-MINT (narrowing propagates)', async () => {
    const raw = generateRawKey();
    const hash = await hashKey(raw);
    const ops = makeOps({
      secret: raw,
      keys: [
        {
          userId: SERVICE_USER_ID,
          keyPrefix: keyPrefixOf(raw),
          keyHash: hash,
          scopes: [...REQUIRED_SCOPES, 'content:publish_public'],
          isActive: true,
          revoked: false,
        },
      ],
    });

    const outcome = await ensureContentKey(ops, CFG, noopLog);
    expect(outcome).toBe('minted');
    const stored = ops.state.secret!;
    const row = ops.state.keys.find((k) => k.keyPrefix === keyPrefixOf(stored) && k.isActive)!;
    expect(row.scopes).toEqual(REQUIRED_SCOPES);
  });

  it('inactive key -> RE-MINT', async () => {
    const raw = generateRawKey();
    const hash = await hashKey(raw);
    const ops = makeOps({
      secret: raw,
      keys: [
        {
          userId: SERVICE_USER_ID,
          keyPrefix: keyPrefixOf(raw),
          keyHash: hash,
          scopes: REQUIRED_SCOPES,
          isActive: false,
          revoked: true,
        },
      ],
    });

    const outcome = await ensureContentKey(ops, CFG, noopLog);
    expect(outcome).toBe('minted');
    expect(ops.replaceActiveKey).toHaveBeenCalledTimes(1);
  });

  it('revoked-but-still-active row (revoked_at set, is_active true) -> RE-MINT', async () => {
    // The exact decoupled state the revoked-inversion bug would have accepted:
    // is_active alone says "valid", revoked_at says "revoked". revoked MUST win.
    const raw = generateRawKey();
    const hash = await hashKey(raw);
    const ops = makeOps({
      secret: raw,
      keys: [
        {
          userId: SERVICE_USER_ID,
          keyPrefix: keyPrefixOf(raw),
          keyHash: hash,
          scopes: REQUIRED_SCOPES,
          isActive: true,
          revoked: true,
        },
      ],
    });

    const outcome = await ensureContentKey(ops, CFG, noopLog);
    expect(outcome).toBe('minted');
    expect(ops.state.secret).not.toBe(raw);
  });

  it('malformed secret string -> MINT', async () => {
    const ops = makeOps({ secret: 'not-a-key' });
    const outcome = await ensureContentKey(ops, CFG, noopLog);
    expect(outcome).toBe('minted');
    expect(isValidKeyFormat(ops.state.secret!)).toBe(true);
  });

  it('missing service user -> skipped-migration-pending (never a throw/stack-wedge)', async () => {
    const errors: string[] = [];
    const log: Logger = {
      info: () => {},
      warn: () => {},
      error: (m) => errors.push(m),
    };
    const ops = makeOps({ secret: null, userId: null });
    const outcome = await ensureContentKey(ops, CFG, log);
    expect(outcome).toBe('skipped-migration-pending');
    expect(ops.replaceActiveKey).not.toHaveBeenCalled();
    expect(ops.writeSecret).not.toHaveBeenCalled();
    expect(errors.join(' ')).toMatch(/service user not found/i);
  });

  it('never logs the plaintext key', async () => {
    const lines: string[] = [];
    const capturing: Logger = {
      info: (m, meta) => lines.push(m + ' ' + JSON.stringify(meta ?? {})),
      warn: (m, meta) => lines.push(m + ' ' + JSON.stringify(meta ?? {})),
      error: (m, meta) => lines.push(m + ' ' + JSON.stringify(meta ?? {})),
    };
    const ops = makeOps({ secret: null });
    await ensureContentKey(ops, CFG, capturing);
    const plaintext = ops.state.secret!;
    for (const line of lines) {
      expect(line).not.toContain(plaintext);
    }
  });
});

// ---------------------------------------------------------------------------
// buildRdsOps — the REAL field parsing, against realistic RDS Data API shapes
// (correctness review P2: this layer previously had zero coverage; the fake
// ops bypassed the tagged-union parsing entirely).
// ---------------------------------------------------------------------------

describe('buildRdsOps field parsing (mocked AWS clients)', () => {
  const OPS_CFG = {
    clusterArn: 'arn:cluster',
    secretArn: 'arn:db-secret',
    database: 'aistudio',
    contentKeySecretId: 'arn:content-secret',
    serviceUserCognitoSub: 'service-account:psd-atrium-agent',
  };

  let rdsSend: jest.SpyInstance;
  let smSend: jest.SpyInstance;

  beforeEach(() => {
    rdsSend = jest.spyOn(RDSDataClient.prototype, 'send');
    smSend = jest.spyOn(SecretsManagerClient.prototype, 'send');
  });
  afterEach(() => {
    rdsSend.mockRestore();
    smSend.mockRestore();
  });

  it('keysByPrefix: revoked_at PRESENT (isNull omitted, the real AWS shape) -> revoked=true', async () => {
    rdsSend.mockResolvedValueOnce({
      records: [
        [
          { stringValue: '$argon2id$hash' },
          { stringValue: JSON.stringify(REQUIRED_SCOPES) },
          { booleanValue: true },
          { stringValue: '2026-07-12 01:00:00' }, // isNull OMITTED — not false
        ],
      ],
    });
    const rows = await buildRdsOps(OPS_CFG).keysByPrefix('deadbeef', 3);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked).toBe(true);
    expect(rows[0].isActive).toBe(true);
  });

  it('keysByPrefix: revoked_at NULL (isNull true) -> revoked=false', async () => {
    rdsSend.mockResolvedValueOnce({
      records: [
        [
          { stringValue: '$argon2id$hash' },
          { stringValue: JSON.stringify(REQUIRED_SCOPES) },
          { booleanValue: true },
          { isNull: true },
        ],
      ],
    });
    const rows = await buildRdsOps(OPS_CFG).keysByPrefix('deadbeef', 3);
    expect(rows[0].revoked).toBe(false);
  });

  it('keysByPrefix: malformed scopes JSON degrades to [] (row treated as scope-drifted)', async () => {
    rdsSend.mockResolvedValueOnce({
      records: [
        [
          { stringValue: '$argon2id$hash' },
          { stringValue: 'not-json' },
          { booleanValue: true },
          { isNull: true },
        ],
      ],
    });
    const rows = await buildRdsOps(OPS_CFG).keysByPrefix('deadbeef', 3);
    expect(rows[0].scopes).toEqual([]);
  });

  it('resolveServiceUserId: longValue extraction and missing-row null', async () => {
    rdsSend.mockResolvedValueOnce({ records: [[{ longValue: 42 }]] });
    await expect(buildRdsOps(OPS_CFG).resolveServiceUserId()).resolves.toBe(42);
    rdsSend.mockResolvedValueOnce({ records: [] });
    await expect(buildRdsOps(OPS_CFG).resolveServiceUserId()).resolves.toBeNull();
  });

  it('readSecret: ResourceNotFoundException (no version yet) -> null; other errors propagate', async () => {
    smSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'no version', $metadata: {} })
    );
    await expect(buildRdsOps(OPS_CFG).readSecret()).resolves.toBeNull();

    smSend.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(buildRdsOps(OPS_CFG).readSecret()).rejects.toThrow('AccessDenied');
  });

  it('replaceActiveKey: begin -> revoke -> insert -> commit, one transactionId throughout', async () => {
    const calls: string[] = [];
    rdsSend.mockImplementation(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      calls.push(cmd.constructor.name);
      if (cmd.constructor.name === 'BeginTransactionCommand') return { transactionId: 'tx-1' };
      if (cmd.constructor.name === 'ExecuteStatementCommand') {
        expect((cmd.input as { transactionId?: string }).transactionId).toBe('tx-1');
        return { records: [] };
      }
      return {};
    });
    await buildRdsOps(OPS_CFG).replaceActiveKey({
      userId: 3,
      name: KEY_NAME,
      keyPrefix: 'deadbeef',
      keyHash: '$argon2id$hash',
      scopes: REQUIRED_SCOPES,
    });
    expect(calls).toEqual([
      'BeginTransactionCommand',
      'ExecuteStatementCommand',
      'ExecuteStatementCommand',
      'CommitTransactionCommand',
    ]);
  });

  it('replaceActiveKey: a failing statement rolls back and rethrows', async () => {
    const calls: string[] = [];
    rdsSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      calls.push(cmd.constructor.name);
      if (cmd.constructor.name === 'BeginTransactionCommand') return { transactionId: 'tx-1' };
      if (cmd.constructor.name === 'ExecuteStatementCommand') throw new Error('insert failed');
      return {};
    });
    await expect(
      buildRdsOps(OPS_CFG).replaceActiveKey({
        userId: 3,
        name: KEY_NAME,
        keyPrefix: 'deadbeef',
        keyHash: 'h',
        scopes: REQUIRED_SCOPES,
      })
    ).rejects.toThrow('insert failed');
    expect(calls).toContain('RollbackTransactionCommand');
    expect(calls).not.toContain('CommitTransactionCommand');
  });
});

// ---------------------------------------------------------------------------
// CloudFormation handler routing (correctness review P2: previously untested)
// ---------------------------------------------------------------------------

describe('handler (CloudFormation custom resource entry point)', () => {
  const BASE_EVENT = {
    StackId: 'stack-1',
    RequestId: 'req-1',
    LogicalResourceId: 'AtriumContentKeyProvisioner',
    ResponseURL: 'https://example.invalid',
    ResourceType: 'Custom::AtriumContentKey',
    ServiceToken: 'token',
    ResourceProperties: { ServiceToken: 'token', Nonce: '1' },
  };

  const ENV = {
    DB_CLUSTER_ARN: 'arn:cluster',
    DB_SECRET_ARN: 'arn:db-secret',
    DB_NAME: 'aistudio',
    CONTENT_KEY_SECRET_ID: 'arn:content-secret',
    SERVICE_USER_COGNITO_SUB: 'service-account:psd-atrium-agent',
  };

  let rdsSend: jest.SpyInstance;
  let smSend: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, ENV);
    rdsSend = jest.spyOn(RDSDataClient.prototype, 'send');
    smSend = jest.spyOn(SecretsManagerClient.prototype, 'send');
  });
  afterEach(() => {
    rdsSend.mockRestore();
    smSend.mockRestore();
    process.env = { ...savedEnv };
  });

  it('Delete -> clean no-op return preserving the incoming PhysicalResourceId', async () => {
    // Provider-framework contract: a normal return IS success (no Status field).
    const res = await handler({
      ...BASE_EVENT,
      RequestType: 'Delete',
      PhysicalResourceId: 'atrium-content-key-bootstrap',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(res.PhysicalResourceId).toBe('atrium-content-key-bootstrap');
    expect(rdsSend).not.toHaveBeenCalled();
    expect(smSend).not.toHaveBeenCalled();
  });

  it('Create with a missing service user -> returns Outcome=skipped-migration-pending (no throw)', async () => {
    rdsSend.mockResolvedValue({ records: [] }); // resolveServiceUserId -> null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler({ ...BASE_EVENT, RequestType: 'Create' } as any);
    expect(res.Data?.Outcome).toBe('skipped-migration-pending');
  });

  it('Create end-to-end mint: resolve user -> empty secret -> txn replace -> secret write -> SUCCESS minted', async () => {
    rdsSend.mockImplementation(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'BeginTransactionCommand') return { transactionId: 'tx-9' };
      if (name === 'ExecuteStatementCommand') {
        const sql = String((cmd.input as { sql?: string }).sql ?? '');
        if (sql.includes('SELECT id FROM users')) return { records: [[{ longValue: 7 }]] };
        return { records: [] };
      }
      return {};
    });
    const written: string[] = [];
    smSend.mockImplementation(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      if (cmd.constructor.name === 'GetSecretValueCommand') {
        throw new ResourceNotFoundException({ message: 'no version', $metadata: {} });
      }
      if (cmd.constructor.name === 'PutSecretValueCommand') {
        written.push(String((cmd.input as { SecretString?: string }).SecretString));
        return {};
      }
      return {};
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler({ ...BASE_EVENT, RequestType: 'Create' } as any);
    expect(res.Data?.Outcome).toBe('minted');
    expect(written).toHaveLength(1);
    expect(isValidKeyFormat(written[0])).toBe(true);
  });

  it('failures THROW (the Provider framework signals CFN FAILED only via a throw)', async () => {
    // A returned Status:'FAILED' object would be read as SUCCESS by the CDK
    // custom-resources Provider — so errors must propagate out of the handler.
    delete process.env.DB_CLUSTER_ARN;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler({ ...BASE_EVENT, RequestType: 'Update', PhysicalResourceId: 'p-1' } as any)
    ).rejects.toThrow('DB_CLUSTER_ARN');
  });

  it('a transient AWS error propagates as a throw (never swallowed into a return)', async () => {
    rdsSend.mockRejectedValue(new Error('rds throttled'));
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler({ ...BASE_EVENT, RequestType: 'Create' } as any)
    ).rejects.toThrow('rds throttled');
  });
});
