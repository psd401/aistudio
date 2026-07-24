import { test, expect } from "./fixtures";

/**
 * E2E guard: /admin hub landing page — always-run, CI-safe.
 *
 * /admin is the card-grid hub for every administration surface. It lives under
 * (protected)/admin, so an unauthenticated request must be redirected to
 * sign-in (307) by the middleware BEFORE the page (and its requireRole check)
 * ever runs. Mirrors atrium-admin.guard.spec.ts: assert the SPECIFIC 307 +
 * location so a regression that downgrades the gate is caught. The
 * authenticated hub flow (cards, triage quick-jump) is functional-tier
 * coverage in admin-hub.functional.spec.ts.
 */

test.describe("Admin hub — route auth-gating (always-run)", () => {
  test("GET /admin unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    const res = await request.get("/admin", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });

  test("GET /admin/assistants unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    // Page-level requireRole was added alongside the hub (it was previously
    // missing); the middleware gate is the always-run assertable layer.
    const res = await request.get("/admin/assistants", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });

  test("GET /admin/navigation unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    const res = await request.get("/admin/navigation", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });
});
