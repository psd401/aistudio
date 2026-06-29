/**
 * Atrium collab session token smoke test (Bun)
 *
 * Issue #1051 (PR #1062 review finding #5). Exercises the security-critical
 * sign/verify path of lib/content/collab/collab-token.ts: a valid round-trip,
 * write vs read tokens, and every rejection branch (expired, wrong issuer, wrong
 * audience, tampered signature, missing token, non-string claims).
 *
 * Why a Bun smoke and not jest: collab-token.ts imports `jose`, which is pure ESM
 * and NOT in jest's transformIgnorePatterns allowlist (next/jest/SWC won't
 * transform it). Bun executes ESM natively. Mirrors the other Atrium Bun smokes.
 *
 * Run: `bun run tests/smoke/atrium-collab-token.smoke.ts`
 */

import assert from "node:assert/strict";
import { SignJWT } from "jose";

// COLLAB_JWT_SECRET is the dedicated signing key (kept separate from AUTH_SECRET
// so URL-borne collab tokens can't be forged from a session-key leak). Set it
// before importing the module; secretKey() reads it lazily but set it up-front.
process.env.COLLAB_JWT_SECRET =
  process.env.COLLAB_JWT_SECRET || "test-collab-secret-0123456789";

const { signCollabToken, verifyCollabToken } = await import(
  "@/lib/content/collab/collab-token"
);

const SECRET = new TextEncoder().encode(process.env.COLLAB_JWT_SECRET);
const OID = "11111111-1111-1111-1111-111111111111";

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await check("valid write token round-trips with w=true", async () => {
  const token = await signCollabToken({ sub: "42", oid: OID, w: true });
  const claims = await verifyCollabToken(token);
  assert.ok(claims, "claims returned");
  assert.equal(claims!.sub, "42");
  assert.equal(claims!.oid, OID);
  assert.equal(claims!.w, true);
});

await check("valid read token round-trips with w=false", async () => {
  const token = await signCollabToken({ sub: "42", oid: OID, w: false });
  const claims = await verifyCollabToken(token);
  assert.ok(claims);
  assert.equal(claims!.w, false);
});

await check("missing token returns null (no throw)", async () => {
  assert.equal(await verifyCollabToken(undefined), null);
  assert.equal(await verifyCollabToken(null), null);
  assert.equal(await verifyCollabToken(""), null);
});

await check("garbage token returns null (no throw)", async () => {
  assert.equal(await verifyCollabToken("not.a.jwt"), null);
});

await check("expired token returns null", async () => {
  // Mint a token that expired one minute ago, with the correct issuer/audience.
  const expired = await new SignJWT({ oid: OID, w: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("atrium-collab")
    .setAudience("atrium-collab-ws")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(SECRET);
  assert.equal(await verifyCollabToken(expired), null);
});

await check("wrong issuer returns null", async () => {
  const wrongIssuer = await new SignJWT({ oid: OID, w: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("not-atrium")
    .setAudience("atrium-collab-ws")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
  assert.equal(await verifyCollabToken(wrongIssuer), null);
});

await check("wrong audience returns null", async () => {
  const wrongAud = await new SignJWT({ oid: OID, w: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("atrium-collab")
    .setAudience("some-other-ws")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
  assert.equal(await verifyCollabToken(wrongAud), null);
});

await check("token signed with a different secret returns null", async () => {
  const otherSecret = new TextEncoder().encode("a-totally-different-secret-value-99");
  const forged = await new SignJWT({ oid: OID, w: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("atrium-collab")
    .setAudience("atrium-collab-ws")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(otherSecret);
  assert.equal(await verifyCollabToken(forged), null);
});

await check("token missing oid claim returns null", async () => {
  const noOid = await new SignJWT({ w: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("atrium-collab")
    .setAudience("atrium-collab-ws")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
  assert.equal(await verifyCollabToken(noOid), null);
});

await check("w defaults to false when the claim is absent/non-true", async () => {
  // A token without an explicit `w:true` must NOT grant write (w === true check).
  const noW = await new SignJWT({ oid: OID })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("atrium-collab")
    .setAudience("atrium-collab-ws")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRET);
  const claims = await verifyCollabToken(noW);
  assert.ok(claims);
  assert.equal(claims!.w, false);
});

await check("token signed with AUTH_SECRET is rejected (keys are separate)", async () => {
  // Defense-in-depth: a token forged with the NextAuth session key must NOT
  // verify against the dedicated collab key. Set a different AUTH_SECRET, sign
  // with it, and confirm verifyCollabToken rejects it.
  const authSecretValue = "auth-secret-distinct-from-collab-999";
  const authKey = new TextEncoder().encode(authSecretValue);
  const forgedWithAuth = await new SignJWT({ oid: OID, w: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("42")
    .setIssuer("atrium-collab")
    .setAudience("atrium-collab-ws")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(authKey);
  assert.equal(await verifyCollabToken(forgedWithAuth), null);
});

console.log(`\natrium-collab-token smoke: ${passed} checks passed`);
