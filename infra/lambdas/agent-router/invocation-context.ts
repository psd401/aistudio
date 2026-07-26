import * as crypto from "node:crypto";

export const INVOCATION_CONTEXT_AUDIENCE = "psd-agent-internal";
export const INVOCATION_CONTEXT_VERSION = 1;
const DEFAULT_TTL_SECONDS = 15 * 60;

export type InvocationMode = "owner" | "consultation" | "scheduled";

export interface InvocationContextClaims {
  version: typeof INVOCATION_CONTEXT_VERSION;
  audience: typeof INVOCATION_CONTEXT_AUDIENCE;
  actorEmail: string;
  ownerEmail: string;
  mode: InvocationMode;
  sessionId: string;
  workspacePrefix: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface InvocationContextInput {
  actorEmail: string;
  ownerEmail: string;
  mode: InvocationMode;
  sessionId: string;
  workspacePrefix: string;
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Issue a compact owner-bound token for model-facing AgentCore work.
 *
 * The signing secret is readable by the trusted router and Next.js verifier,
 * but has an explicit IAM deny on the AgentCore execution role. The model can
 * read or replay its own token, but cannot change actor, owner, mode, session,
 * prefix, or expiry without invalidating the signature.
 */
export function createInvocationContextToken(
  secret: string,
  input: InvocationContextInput,
  options: { nowSeconds?: number; ttlSeconds?: number; nonce?: string } = {}
): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Agent invocation signing secret must contain at least 32 bytes");
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > DEFAULT_TTL_SECONDS) {
    throw new Error(`Agent invocation context TTL must be between 30 and ${DEFAULT_TTL_SECONDS} seconds`);
  }

  const claims: InvocationContextClaims = {
    version: INVOCATION_CONTEXT_VERSION,
    audience: INVOCATION_CONTEXT_AUDIENCE,
    actorEmail: input.actorEmail.trim().toLowerCase(),
    ownerEmail: input.ownerEmail.trim().toLowerCase(),
    mode: input.mode,
    sessionId: input.sessionId,
    workspacePrefix: input.workspacePrefix,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
    nonce: options.nonce ?? crypto.randomUUID(),
  };

  const encodedClaims = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `v1.${encodedClaims}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
