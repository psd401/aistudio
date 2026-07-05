import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium oversight admin page (Epic #1059 completion) — always-run,
 * CI-safe.
 *
 * /admin/atrium hosts the §26.4 approvals queue + content audit viewer. Its
 * data mutations are server actions (not directly HTTP-probeable), so the
 * meaningful CI-safe surface is the route auth-gating: the page lives under
 * `(protected)`, so an unauthenticated request is redirected to sign-in (307)
 * before the page (and its `requireRole("administrator")` gate) ever runs.
 * The role gate itself is covered by the unit tests on the underlying actions
 * (tests/unit/atrium-approvals-actions.test.ts — every action rejects
 * non-admins server-side, so even a role-gate UI regression cannot expose or
 * decide queue rows).
 */

test.describe("Atrium oversight admin — route auth-gating (always-run)", () => {
  test("GET /admin/atrium unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    // Assert the SPECIFIC 307 + location (not a loose `not.toBe(200)`, which a
    // 500 crash would also satisfy). Mirrors atrium-library.guard.spec.ts.
    const res = await request.get("/admin/atrium", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });
});
