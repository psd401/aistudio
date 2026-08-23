import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian library card grid (Epic #1059 redesign, slice B).
 *
 * Drives the restyled `/atrium` library as an authenticated capability holder:
 * the Meridian search field (⌘K-focusable), the filter chips (All / Docs /
 * Artifacts, plus the orthogonal owner select exercising the server `owner:
 * "shared"` filter), the content card grid, and the dashed "Create with the
 * agent" card. Screenshots land in docs/verification/meridian/.
 *
 * Gated behind PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-
 * testing.md for the :3100 host-server prereqs.
 */

const SHOT_DIR = "docs/verification/meridian";

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
      for (const label of ["All", "Docs", "Artifacts"]) {
        await expect(chips.getByRole("button", { name: label })).toBeVisible();
      }

      // Search field (⌘K hint) + create affordances.
      const search = page.getByRole("textbox", {
        name: "Search content by title or tag",
      });
      await expect(search).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New doc" })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New page" })
      ).toBeVisible();

      // The usability pass opens on the curated Home. The full card grid and
      // its dashed create card live behind the one-click All content view.
      const allContent = chips.getByRole("button", { name: "All content" });
      await expect(async () => {
        await allContent.click();
        await expect(allContent).toHaveAttribute("aria-pressed", "true", {
          timeout: 1500,
        });
      }).toPass({ timeout: 30_000 });
      await expect(page.locator('a[href^="/atrium/"]').first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: /New interactive page/i })
      ).toBeVisible();

      await page.screenshot({
        path: `${SHOT_DIR}/02-library-cards.png`,
        fullPage: false,
      });

      // ⌘K focuses the search.
      await page.keyboard.press("Meta+k");
      await expect(search).toBeFocused();

      // Ownership is an ORTHOGONAL select, not a chip: chips are single-select,
      // so "Mine" as a chip meant giving up "Docs" and could never answer "show
      // me MY docs". Combining the two is the point, so drive both and assert
      // the grid survives the owner-scoped reload.
      const ownerFilter = page.getByTestId("library-owner-filter");
      await expect(ownerFilter).toBeVisible();
      await ownerFilter.selectOption("shared");
      await expect(ownerFilter).toHaveValue("shared");

      // Owner + kind together — the combination the chip row could not express.
      await ownerFilter.selectOption("mine");
      await chips.getByRole("button", { name: "Docs" }).click();
      await expect(ownerFilter).toHaveValue("mine");
      await expect(chips.getByRole("button", { name: "Docs" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );

      // The create card is always present (proves no crash / no error state).
      await expect(
        page.getByRole("button", { name: /New interactive page/i })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
