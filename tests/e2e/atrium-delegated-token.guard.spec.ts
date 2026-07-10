import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium delegated-token minting endpoint (§26.1, Epic #1059) — always-run, CI-safe.
 *
 * POST /api/v1/agents/delegated-token runs under withApiAuth, which authenticates
 * BEFORE any handler logic. With no Authorization header and no session cookie,
 * the unauthenticated `{ request }` fixture deterministically gets 401 — proving
 * the route is wired and auth-gated, and that no token is minted for an
 * anonymous caller.
 *
 * The authenticated functional flow (agent client-credentials JWT holding
 * `content:delegate` → mint → use the delegated token on /api/v1/content) needs a
 * registered agent identity + the OIDC signer and is covered by the unit suite
 * (tests/unit/atrium-delegated-token*.test.ts) and the manual runbook.
 */

test.describe("Atrium delegated-token endpoint — unauthenticated 401 (always-run)", () => {
  test("POST /api/v1/agents/delegated-token -> 401, no token minted", async ({ request }) => {
    const res = await request.post("/api/v1/agents/delegated-token", {
      data: { delegated_for: 1, scope: "content:read" },
    });
    expect(res.status()).toBe(401);

    // The error envelope must not carry a minted token in any shape.
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("access_token");
  });
});
