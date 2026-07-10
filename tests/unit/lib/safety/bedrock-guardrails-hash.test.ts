/**
 * Regression tests for the GUARDRAIL_HASH_SECRET handling
 * (Issue #727 hardening → 2026-07-06 chat outage).
 *
 * The old behavior THREW from the constructor when NODE_ENV=production and no
 * hash secret was configured. Because the guardrails service is constructed
 * lazily on the first chat request, that "startup error" actually surfaced as
 * a 500 on EVERY Nexus chat request in any production-build environment
 * missing the env var (it took down deployed dev). The contract now:
 *
 *   - construction NEVER throws over a missing hash secret;
 *   - with no secret, hashValue() refuses to hash and returns the fixed
 *     'redacted' placeholder (zero correlation possible — strictly more
 *     private than HMAC-ing with the old repo-visible default literal);
 *   - with a secret, ids are HMAC-pseudonymized as before.
 */

import { BedrockGuardrailsService } from "@/lib/safety/bedrock-guardrails-service";

type HashCapable = { hashValue(value: string): string };

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  process.env = { ...ORIGINAL_ENV };
}

afterEach(restoreEnv);

describe("BedrockGuardrailsService hash-secret handling", () => {
  it("does NOT throw in production when GUARDRAIL_HASH_SECRET is missing (chat availability)", () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      AWS_REGION: "us-east-1",
    };
    delete process.env.GUARDRAIL_HASH_SECRET;

    expect(() => new BedrockGuardrailsService()).not.toThrow();
  });

  it("returns the fixed 'redacted' placeholder instead of hashing with a known default", () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      AWS_REGION: "us-east-1",
    };
    delete process.env.GUARDRAIL_HASH_SECRET;

    const service = new BedrockGuardrailsService() as unknown as HashCapable;
    // Two different ids map to the SAME constant — no correlation is possible.
    expect(service.hashValue("session-a")).toBe("redacted");
    expect(service.hashValue("session-b")).toBe("redacted");
  });

  it("HMAC-pseudonymizes ids when a secret IS configured", () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      AWS_REGION: "us-east-1",
      GUARDRAIL_HASH_SECRET: "unit-test-secret",
    };

    const service = new BedrockGuardrailsService() as unknown as HashCapable;
    const a = service.hashValue("session-a");
    const b = service.hashValue("session-b");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    // Deterministic for the same id (correlation works WITH the secret).
    expect(service.hashValue("session-a")).toBe(a);
    // And never the redacted placeholder.
    expect(a).not.toBe("redacted");
  });
});
