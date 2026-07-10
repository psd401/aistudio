import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium Phase 7 public reader route (#1057) — always-run, CI-safe.
 *
 * The public reader `app/(public)/p/[slug]/page.tsx` is deliberately ANONYMOUS: it
 * is listed in `middleware.ts` `PUBLIC_PATHS`, so an unauthenticated request must
 * NOT be redirected to sign-in (as every protected route is). This guard proves
 * the route is wired as public WITHOUT needing a session or seeded data — it only
 * asserts the middleware does not gate it. The per-case masking (public renders /
 * non-public 404s) is covered by the unit test (atrium-public-reader-page.test.tsx)
 * and the gated functional spec (atrium-public-reader.functional.spec.ts).
 *
 * We use maxRedirects: 0 so a middleware sign-in redirect surfaces as a 3xx here
 * rather than being followed. A public route instead RENDERS (404 for an unknown
 * slug when the DB is reachable, or a 5xx if it is not) — never a redirect to
 * /api/auth/signin.
 */

// A well-formed but absent slug. The route is public, so the page runs and 404s
// (or errors without a DB) — it must never redirect to sign-in.
const SOME_SLUG = "definitely-not-a-real-atrium-slug-00000000";

test.describe("Atrium public reader — anonymous, not sign-in-gated (always-run)", () => {
  test("GET /p/[slug] is NOT redirected to sign-in (route is public)", async ({
    request,
  }) => {
    const res = await request.get(`/p/${SOME_SLUG}`, { maxRedirects: 0 });
    // A protected route returns a 307/302 redirect to /api/auth/signin for an
    // unauthenticated caller; the public reader must not.
    expect(res.status()).not.toBe(307);
    expect(res.status()).not.toBe(302);
    expect(res.headers()["location"] ?? "").not.toContain("/api/auth/signin");
  });
});
