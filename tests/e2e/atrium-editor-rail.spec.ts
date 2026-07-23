import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium collaborative editor — human typing paints the green rail
 * (Epic #1059 completion).
 *
 * Closes the previously un-automated editor/rail leg of the Phase 1 reference
 * flow (see the header of atrium-document-reference.spec.ts, which covers the
 * publish → visibility → reader half): the signed-in human opens the REAL
 * TipTap/Yjs editor over the collab WebSocket, types two lines, and each typed
 * block carries the human provenance rail (`.atrium-rail-block
 * [data-author="human"]` — the node decoration painted by
 * components/atrium/provenance-rail.ts) plus the inline human-authored mark.
 *
 * Unlike atrium-phase1-verify.spec.ts (which needs the agent Y.Doc state +
 * S3 seeding), this spec needs only the standard editor seed: an empty doc is
 * fine — the collab server initializes doc state on first connect and typing
 * creates the asserted human-authored blocks.
 *
 * PREREQUISITES (why this is gated):
 *  - Host dev server via `bun run server.ts` on :3100 (the collab WS lives in
 *    the custom server) with PLAYWRIGHT_AUTH_ENABLED=true
 *    (docs/guides/e2e-authenticated-testing.md).
 *  - Seed the document: tests/e2e/fixtures/atrium-editor-seed.sql (owned by the
 *    admin e2e-test-user, so the minted session gets canEdit=true).
 */

const OBJ_ID =
  process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";

test.describe("Atrium editor — human edits paint the green rail (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + seeded doc — see tests/e2e/fixtures/atrium-editor-seed.sql"
  );

  test("typing two lines as the signed-in human creates human-authored rail blocks", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // default admin = the seeded doc's owner
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${OBJ_ID}/edit`);

      // The collab session resolved and granted edit (owner): the editor flips
      // editable and the Meridian sheet byline reports the synced ("saved") state
      // (the old "Connected" toolbar label was superseded by the sheet byline +
      // live presence in the slice-C redesign). Generous timeouts — the WS
      // handshake + Yjs sync can be slow on a cold dev server.
      const pm = page.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", {
        timeout: 60000,
      });
      await expect(page.getByTestId("editor-byline")).toContainText("saved", {
        timeout: 60000,
      });

      // Type two lines as the human. Unique markers per run — the Y.Doc state
      // persists across runs, so fixed strings would not prove THIS run typed.
      const marker = `Rail check ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.type(`${marker} line one`);
      await page.keyboard.press("Enter");
      await page.keyboard.type(`${marker} line two`);

      // The typed text is attributed to the human via the inline authored mark…
      await expect(
        page.locator('.ProseMirror span[data-author="human"]').first()
      ).toBeVisible({ timeout: 60000 });

      // …and BOTH typed lines are human-dominant blocks carrying the green rail
      // decoration (the per-block vote in provenance-rail.ts). Assert two
      // distinct rail blocks (>= 2 — earlier runs may have left more).
      const humanBlocks = page.locator('.atrium-rail-block[data-author="human"]');
      await expect(humanBlocks.first()).toBeVisible({ timeout: 60000 });
      await expect(humanBlocks.nth(1)).toBeVisible({ timeout: 60000 });

      // Both typed lines landed in the doc (belt-and-suspenders for the marker).
      await expect(pm).toContainText(`${marker} line one`);
      await expect(pm).toContainText(`${marker} line two`);
    } finally {
      await context.close();
    }
  });
});
