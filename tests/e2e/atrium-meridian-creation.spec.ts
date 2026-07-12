import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium Meridian creation flow + consolidated editor topbar
 * (Epic #1059 polish).
 *
 * Proves the README Interactions creation model + the Meridian topbar
 * consolidation the polish pass shipped:
 *  - "New doc" opens a BLANK sheet immediately — no create modal — and navigates
 *    straight to the editor, where the sheet title is inline-editable (the rename
 *    persists and lifts to the topbar breadcrumb).
 *  - "New artifact" opens a single agent-PROMPT field (not the old title form).
 *  - the primary "Publish ▾" split control houses destination + publish +
 *    unpublish + snapshot (replacing the old naked native select + separate
 *    Publish / Unpublish / Snapshot buttons).
 *
 * Gated behind PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-
 * testing.md for the :3100 host-server prereqs.
 */

test.describe("Atrium Meridian creation flow (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );

  test("New doc opens a blank sheet immediately with an inline-editable title", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/atrium");
      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible({ timeout: 60000 });

      // "New doc" navigates straight to a blank editor — NO create dialog.
      await page.getByRole("button", { name: "New doc" }).click();
      await page.waitForURL(/\/atrium\/[0-9a-f-]+\/edit/, { timeout: 30000 });
      await expect(page.locator(".mer-sheet")).toBeVisible({ timeout: 60000 });
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The sheet title is inline-editable; a rename lifts to the breadcrumb.
      const editableTitle = page.locator(".mer-sheet-title-edit");
      await expect(editableTitle).toBeVisible();
      await editableTitle.click();
      await page.keyboard.press("ControlOrMeta+a");
      const newTitle = `Renamed ${Date.now()}`;
      await page.keyboard.type(newTitle);
      // Blur commits (click into the body).
      await page.locator(".ProseMirror").click();
      await expect(page.locator(".mer-breadcrumb-title")).toHaveText(newTitle, {
        timeout: 15000,
      });
    } finally {
      await context.close();
    }
  });

  test("New artifact opens the single agent-prompt field", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/atrium");
      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible({ timeout: 60000 });

      await page.getByRole("button", { name: "New artifact" }).click();
      // A single free-text prompt surface, not a title form.
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.locator('[data-slot="dialog-title"]')
      ).toHaveText("Create with the agent");
      await expect(
        dialog.getByRole("textbox", {
          name: "Describe the artifact for the agent to build",
        })
      ).toBeVisible();
      // It is a PROMPT field, not the old single-line title input.
      await expect(dialog.locator("textarea.mer-prompt-field")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("editor Publish ▾ consolidates destination + publish + unpublish", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      // A fresh owned doc (so canEdit → the Publish control renders).
      await page.goto("/atrium");
      await page.getByRole("button", { name: "New doc" }).click();
      await page.waitForURL(/\/atrium\/[0-9a-f-]+\/edit/, { timeout: 30000 });
      await expect(page.locator(".mer-editor-topbar")).toBeVisible({
        timeout: 60000,
      });

      // The primary Publish ▾ split control opens a Meridian dropdown that houses
      // the destination + publish + unpublish actions (no naked native <select>).
      await page.getByTestId("publish-menu-trigger").click();
      await expect(
        page.getByRole("menuitem", { name: /Publish to intranet/i })
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: /Unpublish from intranet/i })
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: /Save a version/i })
      ).toBeVisible();
      // The old naked native destination select is gone.
      await expect(
        page.getByTestId("publish-destination-select")
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
