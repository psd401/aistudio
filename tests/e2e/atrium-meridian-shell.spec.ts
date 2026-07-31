import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian shell (Epic #1059 redesign, slice A).
 *
 * Drives the real `/atrium` shell as an authenticated `atrium-content` holder and
 * proves the Meridian foundation is wired:
 *  - the `.meridian` token scope is present on the shell root,
 *  - the 64px icon rail (nav "Atrium") renders with the Library tile,
 *  - the 236px workspace nav column mounts on the library index with its section
 *    tree + AGENT ACTIVITY panel,
 *  - and — critically — the Meridian scope does NOT leak onto a non-Atrium route
 *    (/dashboard has neither the scope class nor the rail).
 *
 * Screenshots land in docs/verification/meridian/ (visual evidence for the
 * PR). Gated behind PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-
 * testing.md for the :3100 host-server prereqs.
 */

const SHOT_DIR = "docs/verification/meridian";

test.describe("Atrium Meridian shell (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("shell renders the icon rail + workspace column and scopes Meridian to /atrium", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await authenticateContext(context); // default admin holds atrium-content
    try {
      const page = await context.newPage();
      await page.goto("/atrium");

      // The library frame mounted (capability holder — not redirected).
      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible();

      // Meridian token scope is present on the shell root.
      await expect(page.locator(".meridian").first()).toBeVisible();

      // The 64px icon rail (its own landmark) with the Library tile.
      const rail = page.getByRole("navigation", { name: "Atrium" });
      await expect(rail).toBeVisible();
      await expect(rail.getByRole("link", { name: "Library" })).toBeVisible();

      // The 236px workspace nav column with the section tree + AGENT ACTIVITY.
      const workspace = page.getByRole("complementary", { name: "Workspace" });
      await expect(workspace).toBeVisible();
      await expect(workspace.getByText("Workspace", { exact: true })).toBeVisible();
      await expect(
        workspace.getByText("Agent activity", { exact: true })
      ).toBeVisible();
      // The reused (visibility-filtered) section tree is inside the column.
      await expect(
        workspace.getByRole("navigation", { name: "Content sections" })
      ).toBeVisible();

      // Let async panels settle (section tree + content list + user avatar) so
      // the evidence screenshot shows the loaded shell, not spinners.
      await expect(
        workspace.getByText("Loading sections…")
      ).toHaveCount(0);
      await expect(page.locator('a[href^="/atrium/"]').first()).toBeVisible();

      await page.screenshot({
        path: `${SHOT_DIR}/01-shell-library.png`,
        fullPage: false,
      });

      // --- Scope boundary ------------------------------------------------------
      // Meridian is now the design system for EVERY authenticated surface, applied
      // at app/(protected)/layout.tsx, so its presence off /atrium is the intended
      // state rather than leakage. This guard previously asserted the opposite —
      // that `.meridian` did not exist on /dashboard — which encoded the old
      // Atrium-only architecture.
      //
      // What still must not leak is Atrium's own CHROME, and the palette must not
      // reach unauthenticated surfaces. Both are asserted below.
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.locator(".meridian").first()).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Atrium" })
      ).toHaveCount(0);

      // Public routes are deliberately still on the global theme.
      await page.goto("/");
      await expect(page.locator(".meridian")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
