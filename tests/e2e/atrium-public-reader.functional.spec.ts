import { test, expect } from "./fixtures";

/**
 * E2E (gated): Atrium Phase 7 public reader (#1057) — the §31.2 acceptance flow.
 *
 * Asserts the anonymous `public_web` reader (`/p/[slug]`) satisfies the Phase 7
 * acceptance criteria:
 *   (a) a PUBLIC object with a live public_web publication renders at the anonymous
 *       route (200) — WITHOUT any session,
 *   (b) a NON-PUBLIC object (internal) that is also live on public_web does NOT
 *       render (404) — the strict `visibility_level='public'` gate, and
 *   (c) an unknown slug 404s (existence-masking).
 *
 * The reader is anonymous, so this uses the unauthenticated `request` fixture (no
 * `authenticateContext`). It is gated because it needs the host dev server + the
 * seeded objects.
 *
 * PREREQUISITES (why the suite is gated):
 *  - Run against the host dev server with PLAYWRIGHT_AUTH_ENABLED=true
 *    (see docs/guides/e2e-authenticated-testing.md — same host-server setup).
 *  - Seed with tests/e2e/fixtures/atrium-public-seed.sql (psql -f …). It creates a
 *    public document published live to public_web and an internal document also
 *    live on public_web (the strict-gate case).
 *  - Optionally override the slugs via env: ATRIUM_PUBLIC_SLUG, ATRIUM_NONPUBLIC_SLUG.
 */

const PUBLIC_SLUG = process.env.ATRIUM_PUBLIC_SLUG ?? "atrium-public-welcome";
const NONPUBLIC_SLUG =
  process.env.ATRIUM_NONPUBLIC_SLUG ?? "atrium-internal-not-public";
const ABSENT_SLUG = "atrium-slug-that-does-not-exist-00000000";

test.describe("Atrium public reader — anonymous public_web", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the host dev server + seeded public objects — see tests/e2e/fixtures/atrium-public-seed.sql"
  );

  test("(a) renders a PUBLIC object at the anonymous route (200, no session)", async ({
    request,
  }) => {
    const res = await request.get(`/p/${PUBLIC_SLUG}`);
    expect(res.status()).toBe(200);
  });

  test("(b) 404s a NON-PUBLIC object even when live on public_web (strict public gate)", async ({
    request,
  }) => {
    const res = await request.get(`/p/${NONPUBLIC_SLUG}`);
    // The public reader gates on visibility_level='public', not merely on a live
    // public_web publication. A non-public object must 404, never 403 (which would
    // confirm the slug exists and let a probe enumerate it).
    expect(res.status()).toBe(404);
  });

  test("(c) 404s an unknown slug (existence-masking)", async ({ request }) => {
    const res = await request.get(`/p/${ABSENT_SLUG}`);
    expect(res.status()).toBe(404);
  });
});
