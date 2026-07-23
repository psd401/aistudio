import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium Phase 4 library / navigation surface (#1054) — always-run,
 * CI-safe.
 *
 * Phase 4 adds the content library landing at `/atrium` (the visibility-filtered
 * `CollectionTree` + content list) and the unpublish control. It introduces NO new
 * API routes — `collectionTreeAction` / `unpublishDocumentAction` / `listContentAction`
 * are server actions, not directly HTTP-probeable — so the meaningful CI-safe
 * surface is the route auth-gating: `/atrium` is under `(protected)`, so an
 * unauthenticated request is redirected to sign-in (307) before the page (and its
 * `atrium-content` capability check) ever runs.
 *
 * The full authenticated flow (library renders the visibility-filtered tree,
 * create → editor, publish → unpublish) is the gated functional spec
 * atrium-library.spec.ts (PLAYWRIGHT_AUTH_ENABLED=true + the seed/migration
 * prereqs in docs/guides/e2e-authenticated-testing.md).
 */

test.describe("Atrium library surface — route auth-gating (always-run)", () => {
  test("GET /atrium unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    // Under (protected): the middleware redirects an unauthenticated request to
    // sign-in (307) before the page runs. Assert the SPECIFIC 307 + location (not
    // a loose `not.toBe(200)`, which a 500 crash would also satisfy) so a
    // regression that downgrades the gate — or serves the library outright — is
    // caught. Mirrors the /atrium/[id]/edit guard in atrium-artifact.guard.spec.ts.
    const res = await request.get("/atrium", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });
});
