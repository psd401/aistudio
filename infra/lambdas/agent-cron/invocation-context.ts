import * as crypto from 'node:crypto';

const INVOCATION_CONTEXT_AUDIENCE = 'psd-agent-internal';
const INVOCATION_CONTEXT_VERSION = 1;
const DEFAULT_TTL_SECONDS = 15 * 60;

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
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds)
    || ttlSeconds < 30
    || ttlSeconds > DEFAULT_TTL_SECONDS
  ) {
    throw new Error(
      `Agent invocation context TTL must be between 30 and ${DEFAULT_TTL_SECONDS} seconds`,
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
