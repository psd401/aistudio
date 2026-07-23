import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian editor (Epic #1059 redesign, slice C).
 *
 * Drives the REAL collaborative editor as the signed-in owner and proves the
 * Meridian editor surface is wired end to end:
 *  - the white sheet on the soft desk (`.mer-sheet` / `.mer-editor-desk`) with the
 *    topbar (breadcrumb + title),
 *  - the floating dark formatting toolbar (TipTap BubbleMenu) appears on a text
 *    selection and Bold + Underline actually apply (`<strong>` / `<u>` land in the
 *    ProseMirror doc — exercising the StarterKit underline mark the toolbar drives),
 *  - real presence: the local author's own awareness avatar renders, and a SECOND
 *    browser context editing the same doc makes the first context's presence stack
 *    grow (real Yjs awareness sync, not a faked dot).
 *
 * Screenshots land in docs/verification/atrium-meridian/ (PR visual evidence).
 *
 * PREREQUISITES (why this is gated) — same as atrium-editor-rail.spec.ts:
 *  - Host dev server via `bun run server.ts` on :3100 (the collab WS lives in the
 *    custom server) with PLAYWRIGHT_AUTH_ENABLED=true.
 *  - Seed the document: tests/e2e/fixtures/atrium-editor-seed.sql (owned by the
 *    admin e2e-test-user, so the minted session gets canEdit=true).
 */

const OBJ_ID =
  process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";
const SHOT_DIR = "docs/verification/atrium-meridian";

test.describe("Atrium Meridian editor (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + seeded doc — see tests/e2e/fixtures/atrium-editor-seed.sql"
  );

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("Meridian sheet renders, the floating toolbar applies bold+underline, and presence is live", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context); // default admin = the seeded doc's owner
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${OBJ_ID}/edit`);

      // The Meridian sheet + desk + topbar rendered.
      await expect(page.locator(".mer-editor-desk")).toBeVisible({ timeout: 60000 });
      await expect(page.locator(".mer-sheet")).toBeVisible();
      await expect(page.locator(".mer-editor-topbar")).toBeVisible();
      await expect(page.locator(".mer-breadcrumb-title")).toBeVisible();

      // Evidence: the topbar (breadcrumb/title/controls) + the sheet header at the
      // top of the page before any typing scrolls it away.
      await page.screenshot({
        path: `${SHOT_DIR}/01-editor-topbar.png`,
        fullPage: false,
      });

      // Collab connected as the owner: the editor flips editable.
      const pm = page.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", {
        timeout: 60000,
      });

      // The local author's own presence avatar renders (awareness broadcast).
      await expect(page.locator(".mer-presence-avatar").first()).toBeVisible({
        timeout: 60000,
      });

      // Type a fresh line (Enter isolates it), then select EXACTLY the marker by
      // walking back char-by-char. The shared collab doc accumulates content across
      // every run into large paragraphs, so Shift+Home would grab a huge multi-line
      // range; a fixed-length backward selection is deterministic regardless of the
      // doc's size or wrapping, so bold/underline act on the marker alone.
      const marker = `Meridian ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(marker);
      for (let i = 0; i < marker.length; i++) {
        await page.keyboard.press("Shift+ArrowLeft");
      }

      // The floating dark formatting toolbar appears over the selection.
      const bubble = page.locator('[data-testid="editor-bubble-menu"]');
      await expect(bubble).toBeVisible({ timeout: 15000 });
      await page.screenshot({
        path: `${SHOT_DIR}/03-editor-bubble-menu.png`,
        fullPage: false,
      });

      // Bold + Underline apply to the SELECTION: after each click the toolbar's
      // toggle reflects the active mark on the selected marker (aria-pressed), which
      // is the collab-schema mark landing — robust in the noisy shared doc where a
      // DOM tag match would be brittle. The mark also renders (<strong>/<u>).
      const boldBtn = bubble.locator('button[aria-label="Bold"]');
      await boldBtn.click();
      await expect(boldBtn).toHaveAttribute("aria-pressed", "true", {
        timeout: 15000,
      });
      await expect(pm.locator("strong")).not.toHaveCount(0, { timeout: 15000 });

      const underlineBtn = bubble.locator('button[aria-label="Underline"]');
      await underlineBtn.click();
      await expect(underlineBtn).toHaveAttribute("aria-pressed", "true", {
        timeout: 15000,
      });
      await expect(pm.locator("u")).not.toHaveCount(0, { timeout: 15000 });

      await page.screenshot({
        path: `${SHOT_DIR}/02-editor-sheet.png`,
        fullPage: false,
      });

      // --- Real presence: a second context on the SAME doc grows the roster -----
      const before = await page.locator(".mer-presence-avatar").count();
      const context2 = await browser.newContext({
        viewport: { width: 1200, height: 800 },
      });
      await authenticateContext(context2);
      const page2 = await context2.newPage();
      await page2.goto(`/atrium/${OBJ_ID}/edit`);
      await expect(page2.locator(".ProseMirror")).toHaveAttribute(
        "contenteditable",
        "true",
        { timeout: 60000 }
      );

      try {
        // Back in the first context, the awareness roster grew — the second
        // client's presence synced over Yjs (real awareness, not a static dot).
        await expect
          .poll(() => page.locator(".mer-presence-avatar").count(), {
            timeout: 30000,
          })
          .toBeGreaterThan(before);
        await page.screenshot({
          path: `${SHOT_DIR}/04-editor-presence.png`,
          fullPage: false,
        });
      } finally {
        await context2.close();
      }
    } finally {
      await context.close();
    }
  });
});
