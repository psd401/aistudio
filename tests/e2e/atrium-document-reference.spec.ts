import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium Phase 1 reference flow — reader visibility + provenance.
 *
 * Asserts the surface acceptance criteria of the reference E2E (spec §31.3): a
 * published group/intranet document
 *   (a) renders for an in-audience (High School) staff user,
 *   (b) 403s for an out-of-building user,
 *   (c) shows the provenance footer (AI-drafted + human-reviewed).
 *
 * The live-editor leg of the reference flow (agent draft → human edits two lines
 * on the rail) is verified by the provenance unit tests + collab bridge smoke test
 * + the manual runbook (docs/guides/atrium-phase1-verification.md); driving the
 * real Yjs editor with two browser contexts is out of scope for this assertion,
 * which proves the publish → visibility → reader → footer half of the loop.
 *
 * PREREQUISITES (this is why the suite is gated):
 *  - Run against the host dev server with PLAYWRIGHT_AUTH_ENABLED=true
 *    (see docs/guides/e2e-authenticated-testing.md).
 *  - Seed the reference document with tests/e2e/fixtures/atrium-reference-seed.sql
 *    (psql -f …). It creates a group/intranet-published doc with a building=High
 *    School grant, an agent v1 + human v2 (so the footer shows both), and sets
 *    building='High School' on the HS-staff user + a different building on the
 *    out-of-building user.
 *  - Provide the published slug + the two users via env:
 *      ATRIUM_E2E_SLUG, ATRIUM_HS_EMAIL, ATRIUM_HS_SUB,
 *      ATRIUM_OUT_EMAIL, ATRIUM_OUT_SUB
 *    (the seed file documents the defaults below).
 */

const SLUG = process.env.ATRIUM_E2E_SLUG ?? "board-procedure-4040";
const HS_EMAIL = process.env.ATRIUM_HS_EMAIL ?? "hs-staff@example.com";
const HS_SUB = process.env.ATRIUM_HS_SUB ?? "e2e-hs-staff";
const OUT_EMAIL = process.env.ATRIUM_OUT_EMAIL ?? "other-staff@example.com";
const OUT_SUB = process.env.ATRIUM_OUT_SUB ?? "e2e-other-staff";

test.describe("Atrium reference flow — published intranet reader", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session + seeded reference doc — see docs/guides/atrium-phase1-verification.md"
  );

  test("renders for an in-building (High School) staff user with provenance footer", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, HS_EMAIL, HS_SUB);
    try {
      const page = await context.newPage();
      const res = await page.goto(`/c/${SLUG}`);
      expect(res?.status()).toBe(200);
      // Provenance footer: both an AI-drafted and a human-reviewed version exist.
      await expect(page.locator(".atrium-provenance-footer")).toBeVisible();
      await expect(
        page.locator('.atrium-provenance-badge[data-author="agent"]')
      ).toBeVisible();
      await expect(
        page.locator('.atrium-provenance-badge[data-author="human"]')
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("403s for an out-of-building user", async ({ browser }) => {
    const context = await browser.newContext();
    await authenticateContext(context, OUT_EMAIL, OUT_SUB);
    try {
      const res = await context.request.get(`/c/${SLUG}`);
      expect(res.status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});
