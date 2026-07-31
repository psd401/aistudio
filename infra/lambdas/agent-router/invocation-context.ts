import * as crypto from "node:crypto";

export const INVOCATION_CONTEXT_AUDIENCE = "psd-agent-internal";
export const INVOCATION_CONTEXT_VERSION = 1;
export const DEFAULT_INVOCATION_CONTEXT_TTL_SECONDS = 15 * 60;
// The job harness still stops model work at two hours. The extra 30 minutes
// exists only so the root wrapper can drain and commit the workspace afterward.
export const MAX_INVOCATION_CONTEXT_TTL_SECONDS = 150 * 60;

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

export interface AgentRequestProof {
  "X-Agent-Request-Proof-Version": "v1";
  "X-Agent-Request-Proof-Timestamp": string;
  "X-Agent-Request-Proof-Nonce": string;
  "X-Agent-Request-Proof-Body-Sha256": string;
  "X-Agent-Request-Proof-Signature": string;
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function deriveInvocationRequestProofKey(
  secret: string,
  token: string,
): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Agent invocation signing secret must contain at least 32 bytes");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Agent invocation context is malformed");
  }
  let nonce: unknown
  try {
    nonce = (JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { nonce?: unknown }).nonce
  } catch {
    throw new Error("Agent invocation context is malformed")
  }
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
    throw new Error("Agent invocation context nonce is malformed")
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`agent-request-proof:v1:${nonce}`)
    .digest("base64url")
}

export function createAgentRequestProof(
  requestProofKey: string,
  input: {
    method: string;
    route: string;
    body: string | Buffer;
  },
  options: { timestamp?: number; nonce?: string } = {},
): AgentRequestProof {
  const timestamp = String(
    options.timestamp ?? Math.floor(Date.now() / 1000)
  )
  const nonce = options.nonce ?? crypto.randomUUID()
  const method = input.method.toUpperCase()
  const bodySha256 = crypto.createHash("sha256").update(input.body).digest("hex")
  const canonical = [
    "v1",
    timestamp,
    nonce,
    method,
    input.route,
    bodySha256,
  ].join("\n")
  const signature = crypto
    .createHmac("sha256", Buffer.from(requestProofKey, "base64url"))
    .update(canonical)
    .digest("base64url")
  return {
    "X-Agent-Request-Proof-Version": "v1",
    "X-Agent-Request-Proof-Timestamp": timestamp,
    "X-Agent-Request-Proof-Nonce": nonce,
    "X-Agent-Request-Proof-Body-Sha256": bodySha256,
    "X-Agent-Request-Proof-Signature": signature,
  }
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
  const ttlSeconds =
    options.ttlSeconds ?? DEFAULT_INVOCATION_CONTEXT_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 30 ||
    ttlSeconds > MAX_INVOCATION_CONTEXT_TTL_SECONDS
  ) {
    throw new Error(
      `Agent invocation context TTL must be between 30 and ${MAX_INVOCATION_CONTEXT_TTL_SECONDS} seconds`
    );
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
