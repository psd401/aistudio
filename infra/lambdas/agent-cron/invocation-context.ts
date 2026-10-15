import * as crypto from 'node:crypto';

const INVOCATION_CONTEXT_AUDIENCE = 'psd-agent-internal';
const INVOCATION_CONTEXT_VERSION = 1;
export const SCHEDULED_INVOCATION_CONTEXT_TTL_S = 15 * 60;

export function createScheduledInvocationContextToken(
  secret: string,
  input: {
    ownerEmail: string;
    sessionId: string;
    workspacePrefix: string;
  },
  options: { nowSeconds?: number; ttlSeconds?: number; nonce?: string } = {},
): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Agent invocation signing secret must contain at least 32 bytes');
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds =
    options.ttlSeconds ?? SCHEDULED_INVOCATION_CONTEXT_TTL_S;
  if (
    !Number.isInteger(ttlSeconds)
    || ttlSeconds < 30
    || ttlSeconds > SCHEDULED_INVOCATION_CONTEXT_TTL_S
  ) {
    throw new Error(
      `Agent invocation context TTL must be between 30 and ${SCHEDULED_INVOCATION_CONTEXT_TTL_S} seconds`,
    );
  }

  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const claims = {
    version: INVOCATION_CONTEXT_VERSION,
    audience: INVOCATION_CONTEXT_AUDIENCE,
    actorEmail: ownerEmail,
    ownerEmail,
    mode: 'scheduled',
    sessionId: input.sessionId,
    workspacePrefix: input.workspacePrefix,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
    nonce: options.nonce ?? crypto.randomUUID(),
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `v1.${encodedClaims}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

export interface AgentRequestProof {
  'X-Agent-Request-Proof-Version': 'v1';
  'X-Agent-Request-Proof-Timestamp': string;
  'X-Agent-Request-Proof-Nonce': string;
  'X-Agent-Request-Proof-Body-Sha256': string;
  'X-Agent-Request-Proof-Signature': string;
}

/**
 * Per-request proof headers for a call this Lambda makes to an `/api/agent/*`
 * broker route, bound to the exact method, route, and body.
 *
 * Kept in lockstep with the verifier in `lib/agent-workspace/invocation-context.ts`
 * and with the router's identical helper — the canonical string, the base64url
 * proof key, and the header names are all part of that contract.
 */
export function createAgentRequestProof(
  requestProofKey: string,
  input: { method: string; route: string; body: string | Buffer },
  options: { timestamp?: number; nonce?: string } = {},
): AgentRequestProof {
  const timestamp = String(
    options.timestamp ?? Math.floor(Date.now() / 1000),
  );
  const nonce = options.nonce ?? crypto.randomUUID();
  const method = input.method.toUpperCase();
  const bodySha256 = crypto
    .createHash('sha256')
    .update(input.body)
    .digest('hex');
  const canonical = [
    'v1',
    timestamp,
    nonce,
    method,
    input.route,
    bodySha256,
  ].join('\n');
  const signature = crypto
    .createHmac('sha256', Buffer.from(requestProofKey, 'base64url'))
    .update(canonical)
    .digest('base64url');
  return {
    'X-Agent-Request-Proof-Version': 'v1',
    'X-Agent-Request-Proof-Timestamp': timestamp,
    'X-Agent-Request-Proof-Nonce': nonce,
    'X-Agent-Request-Proof-Body-Sha256': bodySha256,
    'X-Agent-Request-Proof-Signature': signature,
  };
}

export function deriveScheduledRequestProofKey(
  secret: string,
  token: string,
): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Agent invocation signing secret must contain at least 32 bytes');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Agent invocation context is malformed');
  }
  let nonce: unknown;
  try {
    nonce = (JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { nonce?: unknown }).nonce;
  } catch {
    throw new Error('Agent invocation context is malformed');
  }
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
    throw new Error('Agent invocation context nonce is malformed');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`agent-request-proof:v1:${nonce}`)
    .digest('base64url');
}
