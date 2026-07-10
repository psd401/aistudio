import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E guard: Atrium Phase 2 artifact surfaces (#1052) — always-run, CI-safe.
 *
 * The artifact path adds no new API routes (the canvas loaders are server
 * actions); its public surface is the kind-aware reader at `/c/[slug]` (#1051's
 * route, now rendering artifacts in the cross-origin sandbox) and the authoring
 * page at `/atrium/[id]/edit`.
 *
 * These guards prove the routes are WIRED (auth-gated) without needing a session or
 * a seeded artifact:
 *  - `/c/[slug]` while unauthenticated -> redirected to sign-in. The reader is
 *    under `(protected)`, so read access requires a session (then bounded by
 *    `visibilityService.canView` on the resolved principal). The 404-existence-
 *    masking contract — absent slug and out-of-audience object BOTH -> 404, never
 *    403 — cannot be exercised by an anonymous probe (it is redirected before it
 *    reaches the canView/notFound logic), so it is covered at two OTHER tiers:
 *      • tests/unit/atrium-reader-page-masking.test.tsx drives the real ReaderPage
 *        function and asserts canView===false -> notFound() (always-run, CI-safe);
 *      • the gated functional spec (atrium-visibility-editor.spec.ts) exercises the
 *        full authenticated round-trip when PLAYWRIGHT_AUTH_ENABLED=true.
 *  - `/atrium/[id]/edit` for an absent id while unauthenticated -> redirected to
 *    sign-in (the middleware gates the (protected) route, same 307 as /c/[slug]).
 *
 * The full functional flow (agent generates an artifact -> preview renders
 * sandboxed -> code edit creates a human version -> publish renders a reader page)
 * is exercised by the gated functional spec + the security smokes
 * (atrium-artifact-sandbox-config / -host) that prove the containment.
 */

// A well-formed-but-absent slug / id. The reader resolves to "no live
// publication" and 404s; the value only has to be route-shaped.
const ABSENT_SLUG = "atrium-artifact-guard-does-not-exist";
const SOME_ID = "00000000-0000-0000-0000-000000000000";

test.describe("Atrium artifact surfaces — route auth-gating (always-run)", () => {
  test("GET /c/[slug] unauthenticated -> auth-gated (sign-in redirect, never served)", async ({
    request,
  }) => {
    // The reader is under (protected): an unauthenticated request is redirected to
    // sign-in (307), never served (200). The 404-existence-masking contract (absent
    // slug vs out-of-audience object both -> 404, never 403) is an AUTHENTICATED-tier
    // guarantee — see the gated functional spec — because an anonymous probe is
    // redirected before it reaches the canView/notFound logic.
    const res = await request.get(`/c/${ABSENT_SLUG}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });

  test("GET /atrium/[id]/edit unauthenticated -> sign-in redirect (auth-gated)", async ({
    request,
  }) => {
    // Under (protected): the same middleware that gates /c/[slug] redirects an
    // unauthenticated request to sign-in (307) before the route runs. Assert the
    // SPECIFIC 307 + location header (not a loose `not.toBe(200)`, which a 500
    // server crash would also satisfy) so a regression that downgrades the gate —
    // or starts serving the editor outright — is caught.
    const res = await request.get(`/atrium/${SOME_ID}/edit`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/api/auth/signin");
  });
});

// The seeded inline artifact (tests/e2e/fixtures/atrium-editor-seed.sql), owned
// by the admin so the minted session can open its authoring canvas.
const SEEDED_ARTIFACT_ID =
  process.env.ATRIUM_ARTIFACT_E2E_ID ?? "a7100000-0000-4000-8000-000000007070";

test.describe("Atrium artifact sandbox — runtime isolation attributes (gated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session + seeded artifact — see tests/e2e/fixtures/atrium-editor-seed.sql"
  );

  test("the rendered sandbox iframe carries sandbox=allow-scripts only and an empty allow", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // default admin = the artifact's owner
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${SEEDED_ARTIFACT_ID}/edit`);

      // The canvas resolves to exactly one of: the live sandbox iframe, the
      // fail-closed "sandbox unconfigured" notice, or the frame-load error.
      const frame = page.getByTestId("artifact-sandbox-frame");
      const unavailable = page.getByTestId("artifact-sandbox-unavailable");
      const frameError = page.getByTestId("artifact-sandbox-frame-error");
      await expect(
        frame.or(unavailable).or(frameError).first()
      ).toBeVisible({ timeout: 30000 });

      // Fail-closed states are the CORRECT behavior when ATRIUM_SANDBOX_ORIGIN
      // is not configured (or the sandbox host is unreachable) on the host dev
      // server — there is no frame to inspect, so the attribute proof cannot
      // run. Skip loudly rather than pass vacuously.
      test.skip(
        await unavailable.isVisible(),
        "ATRIUM_SANDBOX_ORIGIN not configured on the host server — fail-closed notice rendered instead of the frame"
      );
      test.skip(
        await frameError.isVisible(),
        "Sandbox host unreachable — frame-error notice rendered instead of the frame"
      );

      // RUNTIME attribute proof of the §28.1 isolation config (not just source
      // inspection): scripts may run, but with NO allow-same-origin the framed
      // document is an opaque origin (an exact-match assertion also proves no
      // other sandbox keyword was added), and the empty allow pins the frame to
      // zero Permissions-Policy feature grants regardless of the parent page.
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      await expect(frame).toHaveAttribute("allow", "");
    } finally {
      await context.close();
    }
  });
});
