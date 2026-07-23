import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian library card grid (Epic #1059 redesign, slice B).
 *
 * Drives the restyled `/atrium` library as an authenticated capability holder:
 * the Meridian search field (⌘K-focusable), the filter chips (All / Docs /
 * Artifacts / Shared with me — the last exercising the new server `owner:
 * "shared"` filter), the content card grid, and the dashed "Create with the
 * agent" card. Screenshots land in docs/verification/atrium-meridian/.
 *
 * Gated behind PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-
 * testing.md for the :3100 host-server prereqs.
 */

const SHOT_DIR = "docs/verification/atrium-meridian";

test.describe("Atrium Meridian library (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("library renders the Meridian card grid, chips, ⌘K search and create card", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/atrium");

      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible();

      // Filter chips.
      const chips = page.getByRole("group", { name: "Filter content" });
      await expect(chips).toBeVisible();
      for (const label of ["All", "Docs", "Artifacts", "Shared with me"]) {
        await expect(chips.getByRole("button", { name: label })).toBeVisible();
      }

      // Search field (⌘K hint) + create affordances.
      const search = page.getByRole("textbox", {
        name: "Search content by title",
      });
      await expect(search).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New doc" })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New artifact" })
      ).toBeVisible();

      // The card grid rendered content links + the dashed create card.
      await expect(page.locator('a[href^="/atrium/"]').first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Create with the agent/i })
      ).toBeVisible();

      await page.screenshot({
        path: `${SHOT_DIR}/02-library-cards.png`,
        fullPage: false,
      });

      // ⌘K focuses the search.
      await page.keyboard.press("Meta+k");
      await expect(search).toBeFocused();

      // "Shared with me" chip is a live filter (reloads without error).
      const sharedChip = chips.getByRole("button", { name: "Shared with me" });
      await sharedChip.click();
      await expect(sharedChip).toHaveAttribute("aria-pressed", "true");
      // The grid re-queries; the create card is always present (proves no crash /
      // no error state after the owner-scoped reload).
      await expect(
        page.getByRole("button", { name: /Create with the agent/i })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
