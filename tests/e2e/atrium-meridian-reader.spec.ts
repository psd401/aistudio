import { test, expect, type BrowserContext } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian reader (Epic #1059 redesign, slice E).
 *
 * Drives the published-page reader (screen 2c) on both surfaces and proves the
 * Meridian reader chrome is wired end to end:
 *  - the internal `/c/[slug]` reader for a NON-editor (HS staff, in-audience but not
 *    the owner) shows the branded intranet nav (with an avatar), the "ON THIS PAGE"
 *    TOC, an explicit "👁 View only" notice, and the "UP TO DATE" pill — and NO Edit
 *    link;
 *  - the SAME page for the OWNER (admin) shows the Edit link and NO view-only notice;
 *  - the anonymous `/p/[slug]` public reader shows the SAME branded nav WITHOUT any
 *    session-dependent chrome (no avatar) and no Edit link;
 *  - the 404 existence-mask still holds (an out-of-building user 404s, not 403).
 *
 * Screenshots land in docs/verification/atrium-meridian/ (07-reader-*). Gated behind
 * PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-testing.md for the
 * :3100 host-server + seed prereqs (atrium-reference-seed.sql + seed-atrium-doc-state
 * for /c/; atrium-public-seed.sql for /p/).
 */

const SHOT_DIR = "docs/verification/atrium-meridian";
const SLUG = "board-procedure-4040";
const PUBLIC_SLUG = process.env.ATRIUM_PUBLIC_SLUG ?? "atrium-public-welcome";

const ADMIN = { email: "test@example.com", sub: "e2e-test-user" };
const HS = { email: "hs-staff@example.com", sub: "e2e-hs-staff" };
const OUT = { email: "other-staff@example.com", sub: "e2e-other-staff" };

async function ctx(
  browser: import("@playwright/test").Browser,
  who: { email: string; sub: string }
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await authenticateContext(context, who.email, who.sub);
  return context;
}

test.describe("Atrium Meridian reader (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server + seeded reader docs — see docs/guides/e2e-authenticated-testing.md"
  );

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("internal reader — non-editor sees intranet nav, TOC, View-only notice + UP TO DATE (no Edit)", async ({
    browser,
  }) => {
    const context = await ctx(browser, HS);
    try {
      const page = await context.newPage();
      const res = await page.goto(`/c/${SLUG}`);
      expect(res?.status()).toBe(200);

      // Branded intranet top nav (org name is branding-derived; "Intranet" is stable)
      // with the authenticated user avatar.
      const nav = page.getByRole("navigation", { name: "Intranet" });
      await expect(nav).toBeVisible();
      await expect(nav.getByText(/Intranet/)).toBeVisible();
      await expect(page.getByTestId("reader-nav-avatar")).toBeVisible();

      // View-only chrome for a non-editor: the notice shows, the Edit link does NOT.
      await expect(page.getByTestId("reader-view-only")).toBeVisible();
      await expect(page.getByTestId("reader-edit-link")).toHaveCount(0);

      // "UP TO DATE" pill near the title (always present on a live-published reader).
      await expect(page.getByTestId("reader-uptodate")).toBeVisible();

      // "ON THIS PAGE" TOC — asserted when the S3 body rendered (the seeded doc has
      // "# Board Procedure 4040 — One-pager" + "## Scope"). CI without S3 renders an
      // empty body (no headings → no TOC), so gate the strict TOC check on the body.
      const bodyText = (await page.locator(".atrium-content").textContent()) ?? "";
      if (bodyText.includes("Scope")) {
        await expect(
          page.getByRole("navigation", { name: "On this page" })
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Scope" })
        ).toBeVisible();
      }

      await page.screenshot({
        path: `${SHOT_DIR}/07-reader-view-only.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });

  test("internal reader — owner sees the Edit link and NO view-only notice", async ({
    browser,
  }) => {
    const context = await ctx(browser, ADMIN);
    try {
      const page = await context.newPage();
      const res = await page.goto(`/c/${SLUG}`);
      expect(res?.status()).toBe(200);

      await expect(page.getByTestId("reader-edit-link")).toBeVisible();
      await expect(page.getByTestId("reader-view-only")).toHaveCount(0);
      await expect(page.getByTestId("reader-uptodate")).toBeVisible();

      await page.screenshot({
        path: `${SHOT_DIR}/07-reader-editor.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });

  test("internal reader — out-of-building user 404s (existence mask, not 403)", async ({
    browser,
  }) => {
    const context = await ctx(browser, OUT);
    try {
      const res = await context.request.get(`/c/${SLUG}`);
      // A non-viewable published doc 404s so its slug cannot be enumerated via 403.
      expect(res.status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  test("public reader — anonymous sees the branded nav WITHOUT user chrome", async ({
    browser,
  }) => {
    // No authenticateContext → a truly anonymous context (the public reader must
    // consult no session and serve the same page to everyone).
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await context.newPage();
      const res = await page.goto(`/p/${PUBLIC_SLUG}`);
      expect(res?.status()).toBe(200);

      // Same branded nav…
      const nav = page.getByRole("navigation", { name: "Intranet" });
      await expect(nav).toBeVisible();
      await expect(nav.getByText(/Intranet/)).toBeVisible();
      // …but NO session-dependent chrome: no avatar, no Edit link.
      await expect(page.getByTestId("reader-nav-avatar")).toHaveCount(0);
      await expect(page.getByTestId("reader-edit-link")).toHaveCount(0);
      await expect(page.getByTestId("reader-uptodate")).toBeVisible();

      await page.screenshot({
        path: `${SHOT_DIR}/07-reader-public.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
});
