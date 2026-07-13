import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian artifact viewer + embed-in-doc (Epic #1059, slice D).
 *
 * Drives the REAL artifact surfaces as the signed-in owner and proves slice D is
 * wired end to end:
 *  - the artifact viewer renders the Meridian chrome — topbar, "● LIVE ARTIFACT"
 *    pill, and the 300px metadata rail (ABOUT / EMBEDDED IN / Ask-the-agent) that
 *    only manage-rights users see — and the "EMBEDDED IN" card lists the seeded
 *    backlink (content_embed_links → the host document);
 *  - embedding an artifact into a document via the floating ✦ embed picker inserts
 *    the live embedded-artifact block (the NodeView resolves the artifact and
 *    renders the Meridian bordered block with its title + Expand link).
 *
 * Screenshots land in docs/verification/atrium-meridian/ (PR visual evidence).
 *
 * PREREQUISITES (why this is gated) — mirrors atrium-meridian-editor.spec.ts:
 *  - Host dev server via `bun run server.ts` on :3100 (the collab WS lives in the
 *    custom server) with PLAYWRIGHT_AUTH_ENABLED=true.
 *  - Seed: tests/e2e/fixtures/atrium-meridian-artifact-seed.sql (an inline artifact,
 *    a host document, and the embed backlink — all owned by the admin e2e-test-user,
 *    so the minted session has manage rights).
 *
 * NOTE (local S3): the reader (`/c/[slug]`, `/p/[slug]`) renders a document body
 * from S3 `source.md`, and the sandbox iframe needs ATRIUM_SANDBOX_ORIGIN — neither
 * is configured in local dev. The reader-render + visibility-masking legs are
 * therefore covered by tests/smoke/atrium-embed-render.smoke.ts (the exact split
 * the reader renders) rather than driven here; this spec asserts the two S3-free UI
 * legs (viewer chrome + editor embed insertion).
 */

const ARTIFACT_ID =
  process.env.ATRIUM_MERIDIAN_ARTIFACT_ID ?? "a7100000-0000-4000-8000-00000000d001";
const DOC_ID =
  process.env.ATRIUM_MERIDIAN_EMBED_DOC_ID ?? "a7100000-0000-4000-8000-00000000d002";
const ARTIFACT_TITLE = "Meridian Metrics Artifact";
const HOST_DOC_TITLE = "Meridian Embed Host Doc";
const SHOT_DIR = "docs/verification/atrium-meridian";

test.describe("Atrium Meridian artifact viewer + embed (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + seeded data — see tests/e2e/fixtures/atrium-meridian-artifact-seed.sql"
  );

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("the artifact viewer renders the Meridian topbar, LIVE pill, and metadata rail with backlinks", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context); // admin owner → manage rights → rail shows
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${ARTIFACT_ID}/edit`);

      // Meridian chrome: topbar + "● LIVE ARTIFACT" pill.
      await expect(page.locator(".mer-editor-topbar")).toBeVisible({ timeout: 60000 });
      await expect(page.locator('[data-testid="artifact-live-pill"]')).toBeVisible();

      // The 300px metadata rail (manage-rights only) with all three cards.
      const rail = page.locator('[data-testid="artifact-meta-rail"]');
      await expect(rail).toBeVisible();
      await expect(rail).toContainText("About");
      await expect(rail).toContainText("Embedded in");
      await expect(page.locator('[data-testid="artifact-ask-agent"]')).toBeVisible();

      // EMBEDDED IN lists the seeded host document (the backlink leg).
      const backlink = page.locator('[data-testid="artifact-backlink"]');
      await expect(backlink).toBeVisible();
      await expect(backlink).toHaveText(HOST_DOC_TITLE);

      // The primary "Open full screen ↗" links to the chrome-free viewer route
      // (#1052) — it works for unpublished artifacts, unlike the /c and /p readers.
      const fullscreen = page.locator('[data-testid="artifact-open-fullscreen"]');
      await expect(fullscreen).toBeVisible();
      await expect(fullscreen).toHaveAttribute("href", `/atrium/${ARTIFACT_ID}/view`);

      await page.screenshot({
        path: `${SHOT_DIR}/05-artifact-viewer.png`,
        fullPage: false,
      });
    } finally {
      await context.close();
    }
  });

  test("embedding an artifact via the ✦ picker inserts a live embed block in the editor", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${DOC_ID}/edit`);

      // Collab connected as the owner: the editor flips editable.
      const pm = page.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60000 });

      // Type a fresh marker line and select it so the floating toolbar appears
      // (a fixed-length backward selection is deterministic in the shared doc).
      const marker = `Embed ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(marker);
      for (let i = 0; i < marker.length; i++) {
        await page.keyboard.press("Shift+ArrowLeft");
      }

      // Open the floating toolbar → the ✦ embed picker.
      const bubble = page.locator('[data-testid="editor-bubble-menu"]');
      await expect(bubble).toBeVisible({ timeout: 15000 });
      await bubble.locator('[data-testid="editor-embed-artifact"]').click();

      // The picker lists the viewer's artifacts; pick the seeded one.
      const picker = page.locator(".mer-bubble-embed-pop");
      await expect(picker).toBeVisible({ timeout: 15000 });
      await picker.locator("button", { hasText: ARTIFACT_TITLE }).first().click();

      // The embedded-artifact block renders in the editor (the NodeView resolved
      // the artifact — available → the Meridian bordered block with its title).
      // Scope to `.first()`: the collab doc persists server-side, so re-runs (and
      // Playwright retries) accumulate embed nodes in the SAME shared document — a
      // bare locator would hit a strict-mode "resolved to N elements" violation.
      const nodeview = page.locator('[data-testid="artifact-embed-nodeview"]').first();
      await expect(nodeview).toBeVisible({ timeout: 30000 });
      const block = page.locator('[data-testid="artifact-embed"]').first();
      await expect(block).toBeVisible({ timeout: 30000 });
      await expect(block).toContainText(ARTIFACT_TITLE);
      await expect(
        page.locator('[data-testid="artifact-embed-expand"]').first()
      ).toBeVisible();

      await page.screenshot({
        path: `${SHOT_DIR}/06-embed-in-doc.png`,
        fullPage: false,
      });
    } finally {
      await context.close();
    }
  });
});
