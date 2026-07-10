import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium Phase 4 content library / navigation IA (#1054, spec §21).
 *
 * Drives the real `/atrium` library landing as an authenticated `atrium-content`
 * holder (the default minted admin session — the capability defaults to
 * administrator + staff). Exercises the Phase 4 path the unit tests cannot:
 * AtriumLibraryPage (capability gate) -> LibraryView (listContentAction) +
 * CollectionTree (collectionTreeAction) rendering the visibility-filtered section
 * tree and the create affordances.
 *
 * This is the always-pruned, server-side-filtered surface, so it asserts the
 * frame is wired and visibility-bounded — not a specific seeded object (the tree
 * is computed from whatever the session may view). The publish -> unpublish
 * round-trip on a seeded document is exercised at the editor in the Phase 1/3
 * functional specs; here we prove the library + section tree mount and gate.
 *
 * PREREQUISITES (why this is gated):
 *  - Host dev server with PLAYWRIGHT_AUTH_ENABLED=true on :3100
 *    (docs/guides/e2e-authenticated-testing.md — migration/seed prereqs).
 *  - The minted session holds `atrium-content` (administrator/staff default), so
 *    the page renders instead of redirecting to /dashboard.
 */

test.describe("Atrium content library (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );

  test("library renders the section tree and create affordances for a capability holder", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // default admin holds atrium-content
    try {
      const page = await context.newPage();
      await page.goto("/atrium");

      // The library frame mounted (not redirected to /dashboard — the minted
      // session holds the capability).
      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible();

      // The visibility-filtered section tree (CollectionTree) is present with its
      // "All content" clear-filter row. The tree itself is pruned server-side, so
      // we assert the landmark + the always-present "All content" entry rather than
      // a specific seeded section.
      const sections = page.getByRole("navigation", { name: "Content sections" });
      await expect(sections).toBeVisible();
      await expect(
        sections.getByRole("button", { name: "All content" })
      ).toBeVisible();

      // Create affordances for an authoring-capable user.
      await expect(page.getByRole("button", { name: "New doc" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New artifact" })
      ).toBeVisible();

      // The filter controls render (title search + tag filter inputs).
      await expect(
        page.getByRole("textbox", { name: "Search content by title" })
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Filter by tag" })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
