/**
 * Unit tests for the atrium-content-key-bootstrap custom resource.
 *
 * Covers the idempotency contract with an in-memory fake of the SM/DB ops:
 *   - empty secret            -> MINT
 *   - valid existing key      -> NO-OP
 *   - stale/orphaned secret   -> RE-MINT
 *   - scope drift             -> RE-MINT
 *   - inactive/revoked key    -> RE-MINT
 *   - missing service user    -> throws
 * plus the real hash-wasm Argon2id round-trip and the pure helpers.
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
  coversScopes,
  type ContentKeyOps,
  type ExistingKeyRow,
  type EnsureConfig,
  type Logger,
} from '../index';

const REQUIRED_SCOPES = [
  'content:read',
  'content:create',
  'content:update',
  'content:publish_internal',
];

const CFG: EnsureConfig = {
  serviceUserCognitoSub: 'service-account:psd-atrium-agent',
  keyName: 'psd-atrium agent (auto-provisioned)',
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
  insertKey: jest.Mock;
  revokeActiveKeys: jest.Mock;
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
  const insertKey = jest.fn(
    async (row: { userId: number; keyPrefix: string; keyHash: string; scopes: string[] }) => {
      state.keys.push({
        userId: row.userId,
        keyPrefix: row.keyPrefix,
        keyHash: row.keyHash,
        scopes: row.scopes,
        isActive: true,
        revoked: false,
      });
    }
  );
  const revokeActiveKeys = jest.fn(async (userId: number) => {
    for (const k of state.keys) {
      if (k.userId === userId && k.isActive) {
        k.isActive = false;
        k.revoked = true;
      }
    }
  });
  return {
    state,
    writeSecret,
    insertKey,
    revokeActiveKeys,
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

  it('coversScopes requires every required scope', () => {
    expect(coversScopes(REQUIRED_SCOPES, REQUIRED_SCOPES)).toBe(true);
    expect(coversScopes([...REQUIRED_SCOPES, 'content:publish_public'], REQUIRED_SCOPES)).toBe(true);
    expect(coversScopes(['content:read'], REQUIRED_SCOPES)).toBe(false);
  });
});

describe('ensureContentKey idempotency', () => {
  it('empty secret -> MINT (key stored, valid, correctly scoped)', async () => {
    const ops = makeOps({ secret: null });
    const outcome = await ensureContentKey(ops, CFG, noopLog);

    expect(outcome).toBe('minted');
    expect(ops.revokeActiveKeys).toHaveBeenCalledWith(SERVICE_USER_ID);
    expect(ops.insertKey).toHaveBeenCalledTimes(1);
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

  it('valid existing key -> NO-OP (no mint, no secret write, no revoke)', async () => {
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
    expect(ops.insertKey).not.toHaveBeenCalled();
    expect(ops.writeSecret).not.toHaveBeenCalled();
    expect(ops.revokeActiveKeys).not.toHaveBeenCalled();
    expect(ops.state.secret).toBe(raw);
  });

  it('stale/orphaned secret (no matching active row) -> RE-MINT', async () => {
    // Secret holds a well-formed sk- key, but there is NO api_keys row for it
    // (e.g. the row was deleted for rotation).
    const orphan = generateRawKey();
    const ops = makeOps({ secret: orphan, keys: [] });

    const outcome = await ensureContentKey(ops, CFG, noopLog);

    expect(outcome).toBe('minted');
    expect(ops.insertKey).toHaveBeenCalledTimes(1);
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

  it('inactive/revoked key -> RE-MINT', async () => {
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
    expect(ops.revokeActiveKeys).toHaveBeenCalledWith(SERVICE_USER_ID);
  });

  it('malformed secret string -> MINT', async () => {
    const ops = makeOps({ secret: 'not-a-key' });
    const outcome = await ensureContentKey(ops, CFG, noopLog);
    expect(outcome).toBe('minted');
    expect(isValidKeyFormat(ops.state.secret!)).toBe(true);
  });

  it('missing service user -> throws (migration must run first)', async () => {
    const ops = makeOps({ secret: null, userId: null });
    await expect(ensureContentKey(ops, CFG, noopLog)).rejects.toThrow(/service user not found/i);
    expect(ops.insertKey).not.toHaveBeenCalled();
    expect(ops.writeSecret).not.toHaveBeenCalled();
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
