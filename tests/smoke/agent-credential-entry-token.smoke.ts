/**
 * Credential-entry consent token smoke test (Bun) — issue #1887.
 *
 * These links carry a live secret-entry form bound to one person, so they get
 * a 15-minute window instead of the 24 hours an OAuth consent link gets, and
 * they are refused outright without a usable target slot name.
 *
 * Why a Bun smoke and not jest: consent-token.ts imports `jose`, which is pure
 * ESM and NOT transformable under next/jest (see the note in jest.config.js).
 * The expiry IS the security property here, so a mocked signer would prove
 * nothing — this runs the real sign/verify path. Mirrors
 * tests/smoke/atrium-collab-token.smoke.ts.
 *
 * Run: `bun run tests/smoke/agent-credential-entry-token.smoke.ts`
 */

import assert from "node:assert/strict";
import { SignJWT } from "jose";

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-credential-entry-secret-0123456789";

const {
  consentTokenExpiry,
  signConsentToken,
  verifyConsentToken,
} = await import("@/lib/agent-workspace/consent-token");

type Payload = Parameters<typeof signConsentToken>[0];

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET);
const OWNER = "owner@psd401.net";

function basePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    sub: OWNER,
    agent: "agnt_owner@psd401.net",
    purpose: "workspace-consent",
    nonce: "a".repeat(64),
    kind: "credential_entry",
    cred: "freshservice_api_key",
    ...overrides,
  };
}

/** Sign with an arbitrary expiry, bypassing signConsentToken's own policy. */
async function signWithExpiry(
  payload: Payload,
  expiration: string | number
): Promise<string> {
  return new SignJWT({ ...payload } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(SECRET);
}

function claims(token: string): { iat: number; exp: number } {
  const [, body] = token.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("Credential-entry consent token (#1887)");

// --- expiry ---------------------------------------------------------------

await check("expires in 15 minutes, not the 24 hours an OAuth link gets", () => {
  assert.equal(consentTokenExpiry("credential_entry"), "15m");
  assert.equal(consentTokenExpiry("canva"), "24h");
  assert.equal(consentTokenExpiry(undefined), "24h");
});

await check("stamps a 15-minute exp on the signed token", async () => {
  const { iat, exp } = claims(await signConsentToken(basePayload()));
  assert.equal(exp - iat, 15 * 60);
});

await check("refuses a token whose 15-minute window has closed", async () => {
  const expired = await signWithExpiry(
    basePayload(),
    Math.floor(Date.now() / 1000) - 1
  );
  assert.equal(await verifyConsentToken(expired), null);
});

await check("still accepts one minted a minute ago", async () => {
  const fresh = await signWithExpiry(
    basePayload(),
    Math.floor(Date.now() / 1000) + 14 * 60
  );
  const payload = await verifyConsentToken(fresh);
  assert.equal(payload?.kind, "credential_entry");
});

// --- target slot name -----------------------------------------------------

await check("round-trips the target credential name", async () => {
  const payload = await verifyConsentToken(
    await signConsentToken(basePayload())
  );
  assert.equal(payload?.sub, OWNER);
  assert.equal(payload?.kind, "credential_entry");
  assert.equal(payload?.cred, "freshservice_api_key");
});

await check("will not sign a credential-entry token with no slot name", async () => {
  await assert.rejects(
    () => signConsentToken(basePayload({ cred: undefined })),
    /require a valid `cred`/
  );
});

await check("will not sign one whose slot name breaks the grammar", async () => {
  await assert.rejects(
    () => signConsentToken(basePayload({ cred: "../../etc/passwd" })),
    /require a valid `cred`/
  );
});

await check("refuses a validly-signed token that carries no slot name", async () => {
  // Forged WITH the signing secret but without `cred`: the page would have
  // nowhere to put the secret, so this must fail closed.
  const token = await signWithExpiry(basePayload({ cred: undefined }), "15m");
  assert.equal(await verifyConsentToken(token), null);
});

await check("refuses a signed token whose slot name is path traversal", async () => {
  const token = await signWithExpiry(
    basePayload({ cred: "../shared/openai" }),
    "15m"
  );
  assert.equal(await verifyConsentToken(token), null);
});

await check("refuses a tampered signature", async () => {
  const token = await signConsentToken(basePayload());
  const parts = token.split(".");
  parts[2] = `${parts[2].slice(0, -2)}xx`;
  assert.equal(await verifyConsentToken(parts.join(".")), null);
});

// --- the OAuth kinds are untouched ---------------------------------------

await check("OAuth kinds keep a 24h window and carry no cred claim", async () => {
  const token = await signConsentToken(
    basePayload({ kind: "canva", cred: undefined })
  );
  const { iat, exp } = claims(token);
  assert.equal(exp - iat, 24 * 60 * 60);
  const payload = await verifyConsentToken(token);
  assert.equal(payload?.kind, "canva");
  assert.equal(payload?.cred, undefined);
});

console.log(`\n${passed} checks passed`);
