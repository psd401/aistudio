import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium admin surface (Epic #1059 completion) — always-run, CI-safe.
 *
 * The Atrium admin route (`/admin/atrium`, the §26.4 approval-queue surface)
 * lives under `(protected)/admin`, so an unauthenticated request must be
 * redirected to sign-in (307) by the middleware BEFORE the page (and its
 * role/capability checks) ever runs. The middleware matcher covers every
 * non-static path, so this holds regardless of the page's own gating.
 *
 * Mirrors atrium-library.guard.spec.ts: assert the SPECIFIC 307 + location (not
 * a loose `not.toBe(200)`, which a 500 crash would also satisfy) so a
 * regression that downgrades the gate — or serves the admin page outright — is
 * caught. The authenticated admin flow (capability/role gating, queue actions)
 * is functional-tier coverage.
 */

test.describe("Atrium admin surface — route auth-gating (always-run)", () => {
  test("GET /admin/atrium unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    const res = await request.get("/admin/atrium", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });
});
