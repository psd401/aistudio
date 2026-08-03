import { test, expect } from "@playwright/test";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): the Atrium usability pass.
 *
 * Covers the changes that are only observable in a real browser:
 *  (1) the library opens on the curated HOME, not the all-content firehose;
 *  (2) sections are browsable cards that lead to a section landing page with a
 *      hero, and the sidebar distinguishes private sections from shared ones;
 *  (3) a document's reading measure actually uses the window;
 *  (4) favoriting persists across a reload;
 *  (5) a brand-new interactive page opens on editable content, never an error.
 *
 * PREREQUISITES (why the suite is gated):
 *  - the host dev server on :3100 with PLAYWRIGHT_AUTH_ENABLED=true
 *    (see docs/guides/e2e-authenticated-testing.md), and
 *  - `bun run db:seed` so the admin test user's cognito_sub matches the minted
 *    session, plus tests/e2e/fixtures/atrium-public-seed.sql.
 */

const SHOT_DIR = "docs/verification/atrium-usability";

/**
 * The "All content" FILTER CHIP. Scoped to the chip row on purpose: the section
 * sidebar has its own "All content" entry, so an unscoped role query is
 * ambiguous and fails strict mode.
 */
function allContentChip(page: import("@playwright/test").Page) {
  return page
    .getByRole("group", { name: "Filter content" })
    .getByRole("button", { name: "All content" });
}

test.describe("Atrium usability pass", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the host dev server + seeded users — see docs/guides/e2e-authenticated-testing.md"
  );

  test("library opens on the curated home, not the all-content grid", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await authenticateContext(context);
      const page = await context.newPage();
      await page.goto("/atrium");

      // The home replaces the flat grid entirely.
      await expect(page.getByTestId("library-home")).toBeVisible();
      // "Your recent work" always renders (it has an empty state, unlike the
      // optional bands, so its absence would mean the home failed to mount).
      await expect(page.getByTestId("home-band-recent")).toBeVisible();

      // Capture the home itself, with its bands SETTLED — not the grid it can
      // switch to, and not mid-load. Waiting on the band element alone is not
      // enough: the section renders immediately and shows a spinner, so an
      // earlier version of this screenshot evidenced nothing but "Loading…".
      // Wait for real cards (or the recent band's empty state) instead.
      await expect(
        page.locator('[data-testid="home-band-recent"] .mer-band-loading')
      ).toHaveCount(0);
      await expect(
        page.locator('[data-testid="home-band-sections"] .mer-band-loading')
      ).toHaveCount(0);
      await page.screenshot({
        path: `${SHOT_DIR}/01-library-home.png`,
        fullPage: true,
      });

      // "All content" is still reachable in one click — the firehose is a
      // destination now, not the door.
      await allContentChip(page).click();
      await expect(page.getByTestId("library-home")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a section opens its own landing page with a hero", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await authenticateContext(context);
      const page = await context.newPage();
      await page.goto("/atrium");

      const sections = page.getByTestId("home-band-sections");
      // Skip rather than fail on a library with no sections at all — the seed
      // does not guarantee one, and this assertion is about the landing page.
      if ((await sections.count()) === 0) {
        test.skip(true, "No sections visible to the seeded admin");
      }
      // The band element renders immediately with a spinner and fills in after
      // its fetch; clicking before it settles lands on a card that is then
      // re-sorted out from under the click, and no navigation happens.
      await expect(
        page.locator('[data-testid="home-band-sections"] .mer-band-loading')
      ).toHaveCount(0);
      await sections.locator("a").first().click();

      await expect(page).toHaveURL(/\/atrium\/s\//);
      await expect(page.getByTestId("section-landing")).toBeVisible();
      await expect(page.getByTestId("section-title")).toBeVisible();
      // The breadcrumb is the way back up — the flat grid had none.
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();

      // Settle the contents band before the screenshot, or the evidence is a
      // spinner (see the same note on the home screenshot).
      await expect(
        page.locator('[data-testid="section-contents"] .mer-band-loading')
      ).toHaveCount(0);
      await page.screenshot({
        path: `${SHOT_DIR}/02-section-landing.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });

  test("a document uses the window instead of a 700px column", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await authenticateContext(context);
      const page = await context.newPage();
      await page.goto("/p/public-publish-1785707312807299");

      const width = await page
        .locator(".atrium-content")
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      // Was 608px of text on this viewport. The exact number is the measure
      // token's business; what matters is that it is no longer a third of the
      // window.
      expect(width).toBeGreaterThan(900);
    } finally {
      await context.close();
    }
  });

});

test.describe("Atrium usability pass — share and section settings", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the host dev server + seeded users — see docs/guides/e2e-authenticated-testing.md"
  );

  test("Share is one surface: link, audience, and destinations together", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 950 },
    });
    try {
      await authenticateContext(context);
      const page = await context.newPage();
      // The seeded public artifact — it has both a publication and a slug, so
      // the link section has something real to resolve.
      await page.goto("/atrium/a7700000-0000-4000-8000-000000000003/edit");

      // Exactly ONE share entry point. There used to be three overlapping
      // controls (a silent copy-link button, this one, and a Publish ▾ menu).
      await expect(page.getByTestId("share-control")).toHaveCount(1);
      await expect(page.getByTestId("publish-menu-trigger")).toHaveCount(0);
      await expect(page.getByTestId("artifact-share")).toHaveCount(0);

      await page.getByTestId("share-control").click();

      // All three concerns in one dialog.
      await expect(page.getByTestId("share-link-url")).toBeVisible();
      await expect(page.getByTestId("share-copy-link")).toBeVisible();
      await expect(page.getByTestId("share-dest-intranet")).toBeVisible();
      await expect(page.getByTestId("share-dest-public_web")).toBeVisible();
      // The public destination is live for this seed.
      await expect(page.getByTestId("live-public_web")).toBeVisible();
      // Artifacts can be embedded in a document; that moved in here too.
      await expect(page.getByTestId("share-copy-embed")).toBeVisible();

      // A production-length absolute URL is the case that broke the layout —
      // localhost slugs are short enough to hide an unshrinkable flex row.
      const linkWidth = await page
        .getByTestId("share-link-url")
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      const dialogWidth = await page
        .locator('[data-slot="dialog-content"]')
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      // The URL must fit INSIDE the dialog, never push it wider.
      expect(linkWidth).toBeLessThan(dialogWidth);
      // And the dialog itself must stay a dialog, not a full-viewport sheet.
      expect(dialogWidth).toBeLessThanOrEqual(680);

      await page.screenshot({
        path: `${SHOT_DIR}/03-share-dialog.png`,
        fullPage: false,
      });
    } finally {
      await context.close();
    }
  });

  test("a section's description and Start here page are editable in place", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 950 },
    });
    try {
      await authenticateContext(context);
      const page = await context.newPage();
      await page.goto("/atrium");

      const sections = page.getByTestId("home-band-sections");
      if ((await sections.count()) === 0) {
        test.skip(true, "No sections visible to the seeded admin");
      }
      // Settle the band before clicking — see the note in the sibling test.
      await expect(
        page.locator('[data-testid="home-band-sections"] .mer-band-loading')
      ).toHaveCount(0);
      await sections.locator("a").first().click();
      await expect(page.getByTestId("section-landing")).toBeVisible();

      // The hero used to tell people to edit it "in its settings" with no way
      // to get there.
      await page.getByTestId("section-settings").click();

      const description = page.locator("#section-description");
      await expect(description).toBeVisible();
      // The pin picker lists this section's own pages.
      await expect(page.getByTestId("section-start-here")).toBeVisible();

      // Capture the dialog OPEN — the earlier screenshot was taken after save,
      // so it could not evidence the dialog's own styling. This dialog rendered
      // in the app's older cream theme until it got `meridianPortalClassName`;
      // assert the scope class is actually on the portalled content.
      await expect(page.locator('[data-slot="dialog-content"]')).toHaveClass(
        /meridian-portal/
      );
      await page.screenshot({
        path: `${SHOT_DIR}/04-section-settings.png`,
        fullPage: false,
      });

      // A STABLE value, not a timestamp: re-running the suite then re-asserts
      // the same string, so this is idempotent and leaves the local library
      // with a sensible description instead of "Set by E2E at 1785722180699".
      //
      // Deliberately no restore-by-second-save. Saving twice in quick
      // succession queues the second server action behind the `router.refresh()`
      // the first one triggers, and the dialog sits on "Saving…" — an artificial
      // sequence no human produces, but one that made this test hang.
      const text = "Section description set by the E2E suite.";
      await description.fill(text);
      await page.getByRole("button", { name: "Save" }).click();

      // The hero re-renders in place via router.refresh() — the new text
      // appearing IS the settled signal, so there is no navigation to await.
      await expect(page.getByTestId("section-description")).toHaveText(text);

      // And it is durable, not just optimistic client state.
      await page.reload();
      await expect(page.getByTestId("section-description")).toHaveText(text);
    } finally {
      await context.close();
    }
  });

  test("favoriting a card persists across a reload", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await authenticateContext(context);
      const page = await context.newPage();
      await page.goto("/atrium");
      await allContentChip(page).click();

      const star = page.locator('[data-testid^="favorite-"]').first();
      await expect(star).toBeAttached();
      const testId = await star.getAttribute("data-testid");
      expect(testId).toBeTruthy();

      const wasOn = (await star.getAttribute("aria-pressed")) === "true";
      await star.click();
      await expect(star).toHaveAttribute("aria-pressed", String(!wasOn));
      // `aria-pressed` flips OPTIMISTICALLY, before the write lands — reloading
      // on that alone races the server action. Wait for the write to settle.
      await expect(star).toHaveAttribute("data-busy", "false");

      // The whole point of the table: the state survives the round-trip.
      await page.reload();
      await allContentChip(page).click();
      await expect(page.getByTestId(testId as string)).toHaveAttribute(
        "aria-pressed",
        String(!wasOn)
      );

      // Leave the seeded data as we found it.
      const restored = page.getByTestId(testId as string);
      await restored.click();
      await expect(restored).toHaveAttribute("aria-pressed", String(wasOn));
      await expect(restored).toHaveAttribute("data-busy", "false");
    } finally {
      await context.close();
    }
  });
});
