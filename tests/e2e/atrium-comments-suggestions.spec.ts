import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium comments + track-changes (Epic #1059, §18.1).
 *
 * Proves the LIVE editor interactions that unit/smoke tests cannot exercise
 * (they need a real EditorView): creating a comment on a selection, the
 * suggesting-mode INSERT + the risky DELETE interception (a delete becomes a
 * strikethrough proposal, not a removal), and Accept-all clearing the pending
 * suggestions. The pure clean-publish transform is covered by the resolve smoke;
 * the accept/reject helpers by the suggestion-mode smoke — this closes the live gap.
 *
 * Reuses the editor seed (admin-owned private doc → canEdit): apply
 * tests/e2e/fixtures/atrium-editor-seed.sql. Requires the authed host dev server
 * (collab WS) on :3100 with PLAYWRIGHT_AUTH_ENABLED=true.
 */

const OBJ_ID =
  process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";

test.describe("Atrium comments + track-changes (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + seeded doc — see tests/e2e/fixtures/atrium-editor-seed.sql"
  );

  test("comment on a selection, suggest an insert + a delete, then accept all", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // admin = the seeded doc's owner (canEdit)
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${OBJ_ID}/edit`);

      const pm = page.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60000 });
      await expect(page.getByText("Connected")).toBeVisible({ timeout: 60000 });

      // Seed a known line to operate on.
      const marker = `CT ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.type(`${marker} comment-me here`);
      await expect(pm).toContainText(`${marker} comment-me here`);

      // --- COMMENT: select the line (triple-click = deterministic paragraph
      // selection that fires real selection events), add a comment via the sidebar ---
      await pm.click({ clickCount: 3 });
      const sidebar = page.getByTestId("comment-sidebar");
      const composer = sidebar.getByLabel("New comment");
      await expect(composer).toBeEnabled({ timeout: 15000 }); // enabled by the selection
      await composer.fill("Please clarify this line.");
      await sidebar.getByRole("button", { name: "Add comment" }).click();
      // The thread appears in the sidebar and the span carries the comment mark.
      await expect(page.getByTestId("comment-thread").first()).toBeVisible({ timeout: 30000 });
      await expect(pm.locator("span.atrium-comment").first()).toBeVisible({ timeout: 30000 });

      // --- SUGGESTING MODE: insertion ---
      await page.getByTestId("suggesting-toggle").click();
      await expect(page.getByTestId("suggesting-toggle")).toHaveAttribute("aria-pressed", "true");
      // Clicking the toolbar button blurred the editor — refocus it before typing,
      // or the keystrokes never reach ProseMirror.
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" INSERTED-SUGGESTION");
      await expect(pm.locator("span.atrium-suggest-insert").first()).toBeVisible({ timeout: 30000 });

      // --- DELETION interception: select a word and press Delete → strikethrough, text kept ---
      await page.keyboard.down("Shift");
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.up("Shift");
      await page.keyboard.press("Backspace");
      await expect(pm.locator("span.atrium-suggest-delete").first()).toBeVisible({ timeout: 30000 });

      // A non-zero pending-suggestion count is surfaced.
      const count = page.getByTestId("suggestion-count");
      await expect(count).toBeVisible({ timeout: 15000 });

      // --- ACCEPT ALL → pending suggestions resolve to the baseline ---
      await page.getByRole("button", { name: /accept all/i }).click();
      await expect(pm.locator("span.atrium-suggest-insert")).toHaveCount(0, { timeout: 30000 });
      await expect(pm.locator("span.atrium-suggest-delete")).toHaveCount(0, { timeout: 30000 });
    } finally {
      await context.close();
    }
  });
});
