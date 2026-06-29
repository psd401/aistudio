import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium Phase 1 document endpoints (#1051) — always-run, CI-safe.
 *
 * The collab-token and agent-bridge routes check the session FIRST (401 when
 * absent) before loading the object or parsing the body, so the unauthenticated
 * `{ request }` fixture (no browser cookies) deterministically gets 401. This
 * proves the new routes are wired and auth-gated without needing a session.
 *
 * The full reference flow (agent draft → human edit in the editor → publish →
 * HS-staff renders / out-of-building 404 / provenance footer) is the gated
 * functional spec atrium-document-reference.spec.ts + the manual runbook in
 * docs/guides/atrium-phase1-verification.md (it needs the live collab server and
 * building-scoped seed users).
 */

// A well-formed but almost-certainly-absent object id. The 401 fires before the
// object is ever loaded, so the value only has to be route-shaped.
const SOME_ID = "00000000-0000-0000-0000-000000000000";

test.describe("Atrium document endpoints — unauthenticated 401 (always-run)", () => {
  test("GET /api/content/[id]/collab -> 401", async ({ request }) => {
    const res = await request.get(`/api/content/${SOME_ID}/collab`);
    expect(res.status()).toBe(401);
  });

  test("POST /api/content/[id]/agent-bridge -> 401 (session checked before body parse)", async ({
    request,
  }) => {
    const res = await request.post(`/api/content/${SOME_ID}/agent-bridge`, {
      data: { markdown: "# probe" },
    });
    expect(res.status()).toBe(401);
  });
});
