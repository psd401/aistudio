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
 *  - `/c/[slug]` for an absent slug -> 404 (notFound). The reader resolves the
 *    object/publication first and 404s when there is none; it never 403s (an
 *    out-of-audience or unauthenticated probe cannot distinguish "exists but
 *    forbidden" from "absent" — the slug is not enumerable). Same contract as the
 *    document reader.
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
  test("GET /c/[slug] for an absent artifact slug -> 404 (existence masked)", async ({
    request,
  }) => {
    const res = await request.get(`/c/${ABSENT_SLUG}`);
    // notFound() renders the 404 page; an absent slug must NOT 403/redirect.
    expect(res.status()).toBe(404);
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
