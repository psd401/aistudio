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
