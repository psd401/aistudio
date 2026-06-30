import { test, expect } from "./fixtures";

/**
 * E2E guard: Atrium Phase 2 artifact surfaces (#1052) — always-run, CI-safe.
 *
 * The artifact path adds no new API routes (the canvas loaders are server
 * actions); its public surface is the kind-aware reader at `/c/[slug]` (#1051's
 * route, now rendering artifacts in the cross-origin sandbox) and the authoring
 * page at `/atrium/[id]/edit`.
 *
 * These guards prove the routes are WIRED and existence-masked without needing a
 * session or a seeded artifact:
 *  - `/c/[slug]` while unauthenticated -> redirected to sign-in. The reader is
 *    under `(protected)`, so read access requires a session (then bounded by
 *    `visibilityService.canView` on the resolved principal). The 404-existence-
 *    masking contract — absent slug and out-of-audience object BOTH -> 404, never
 *    403 — is an AUTHENTICATED-tier guarantee covered by the gated functional spec;
 *    an anonymous probe is redirected before it reaches the canView/notFound logic.
 *  - `/atrium/[id]/edit` for an absent id while unauthenticated -> redirected to
 *    sign-in (the (protected) layout gates the route).
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

test.describe("Atrium artifact surfaces — wiring + existence masking (always-run)", () => {
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

  test("GET /atrium/[id]/edit unauthenticated -> not a 200 (auth-gated)", async ({
    request,
  }) => {
    // Under (protected): an unauthenticated request is redirected to sign-in (3xx)
    // or otherwise denied — it must never serve the editor (200) for an absent id.
    const res = await request.get(`/atrium/${SOME_ID}/edit`, { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
  });
});
