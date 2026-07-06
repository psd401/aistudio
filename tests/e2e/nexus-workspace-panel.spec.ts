import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Nexus workspace panel (Epic #1059, spec §17) — Atrium content
 * edited BESIDE the chat.
 *
 * The critical assertions are CO-EXISTENCE ones (the panel must never disturb the
 * fragile conversation tree — docs/features/nexus-conversation-architecture.md):
 *  1. /nexus?workspace=<seeded doc> renders BOTH the chat composer AND the panel,
 *     with the real collaborative editor connected inside the panel.
 *  2. Typing in the panel's editor works (the §17 "edit beside chat" promise).
 *  3. Closing the panel clears ONLY the workspace param and the chat remains.
 *
 * Reuses the standard editor seed (tests/e2e/fixtures/atrium-editor-seed.sql,
 * admin-owned doc → canEdit) + the authed host dev server on :3100.
 */

const OBJ_ID =
  process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";

test.describe("Nexus workspace panel (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + seeded doc — see tests/e2e/fixtures/atrium-editor-seed.sql"
  );

  test("chat and workspace panel coexist; editing works; close preserves the chat", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // admin = the seeded doc's owner
    try {
      const page = await context.newPage();
      await page.goto(`/nexus?workspace=${OBJ_ID}`);

      // 1. BOTH surfaces render: the panel with the doc title, and the chat
      //    composer (the conversation tree is intact beside it).
      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60000 });
      const composer = page.locator('[role="textbox"], textarea').first();
      await expect(composer).toBeVisible({ timeout: 60000 });

      // 2. The REAL collaborative editor connects inside the panel and accepts
      //    a human edit (the §17 edit-beside-chat loop).
      const pm = panel.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60000 });

      // 2b. Layout regression guard: the editor must NOT collapse to a sliver
      //     beside the comment rail (the full-page `w-72 md:block` rail keyed off
      //     the VIEWPORT would leave ~80px in this ~469px panel). In `layout=
      //     "panel"` the rail stacks below, so the editor keeps the panel width.
      //     Also: opening the panel must never cause horizontal page overflow.
      const dims = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="workspace-panel"]') as HTMLElement | null;
        const ed = document.querySelector(".atrium-editor") as HTMLElement | null;
        const doc = document.documentElement;
        return {
          panelW: p ? p.getBoundingClientRect().width : 0,
          editorW: ed ? ed.getBoundingClientRect().width : 0,
          horizOverflow: doc.scrollWidth > doc.clientWidth,
        };
      });
      expect(dims.horizOverflow).toBe(false);
      expect(dims.panelW).toBeGreaterThan(0);
      // Editor occupies the bulk of the panel (was ~17% when collapsed).
      expect(dims.editorW).toBeGreaterThan(dims.panelW * 0.7);
      const marker = `WS ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.type(` ${marker}`);
      await expect(pm).toContainText(marker, { timeout: 30000 });

      // 3. Close: the panel unmounts, the workspace param clears, and the chat
      //    composer is still there (no conversation-tree disturbance).
      await page.getByTestId("workspace-close").click();
      await expect(panel).toHaveCount(0, { timeout: 15000 });
      await expect(page).toHaveURL(/\/nexus(?!.*workspace=)/, { timeout: 15000 });
      await expect(composer).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
