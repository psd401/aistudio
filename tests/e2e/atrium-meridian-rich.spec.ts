import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Atrium Meridian rich-content affordances (Epic #1059 redesign, slice F).
 *
 * Drives the REAL editor + library as the signed-in owner and proves the slice-F
 * net-new affordances are wired end to end:
 *  - COVER + EMOJI (DB metadata, no S3): the Change-cover picker sets a preset
 *    gradient + emoji on the doc; the editor renders the 170px cover band + the
 *    emoji tile, and the library doc card then shows the emoji.
 *  - CALLOUT (live collab schema): the floating toolbar's 📣 button inserts an
 *    `atriumCallout` node that renders as `.atrium-callout` in the ProseMirror DOM.
 *  - MEDIA (live collab schema): the 🖼 media picker inserts an image by URL that
 *    renders as an `<img>` in the editor (the AtriumImage node).
 *  - ARTIFACT THUMBNAIL: the library artifact card renders the live-thumbnail
 *    scaffold (branded gradient fallback always; the scaled sandbox frame mounts
 *    only when the sandbox origin is configured — fail-closed otherwise).
 *  - PUBLISHED READER rich blocks (S3-gated): the published reader renders the
 *    slice-F callout from the document body. Documents read their body from S3
 *    `source.md`, so this leg only runs with ATRIUM_E2E_HAS_S3=true (grid/video
 *    reader render is proven by the markdown-render + embed-render smokes, which
 *    exercise the identical reader pipeline).
 *
 * Screenshots land in docs/verification/atrium-meridian/ (PR visual evidence).
 *
 * PREREQUISITES (why this is gated) — same as atrium-meridian-editor.spec.ts:
 *  - Host dev server via `bun run server.ts` on :3100 (the collab WS lives in the
 *    custom server) with PLAYWRIGHT_AUTH_ENABLED=true.
 *  - Seed: tests/e2e/fixtures/atrium-editor-seed.sql (the admin-owned document
 *    a7…6060 + inline artifact a7…7070 — both applied by scripts/test/e2e-local.sh).
 */

const DOC_ID =
  process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";
const ARTIFACT_ID =
  process.env.ATRIUM_ARTIFACT_E2E_ID ?? "a7100000-0000-4000-8000-000000007070";
const SHOT_DIR = "docs/verification/atrium-meridian";
const EMOJI = "🎯";

test.describe("Atrium Meridian rich content (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + seeded doc — see tests/e2e/fixtures/atrium-editor-seed.sql"
  );

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("cover + emoji apply in the editor, the toolbar inserts callout + image, and the emoji shows on the library card", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context); // default admin = the seeded doc's owner
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${DOC_ID}/edit`);

      // The editor is live + editable as the owner.
      const pm = page.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", {
        timeout: 60000,
      });

      // --- Cover band + emoji (DB metadata, persisted via updateContentAction) ---
      // Fresh doc → "Add cover"; a doc that already carries a cover (idempotent
      // re-runs) → "Change cover". Handle both, then open the picker.
      const addCover = page.locator('[data-testid="editor-add-cover"]');
      if (await addCover.count()) {
        await addCover.click();
      } else {
        await page.locator('[data-testid="editor-change-cover"]').click();
      }
      const picker = page.locator('[data-testid="editor-cover-picker"]');
      if (!(await picker.count())) {
        await page.locator('[data-testid="editor-change-cover"]').click();
      }
      await expect(picker).toBeVisible({ timeout: 15000 });

      // Pick the "forest" preset gradient and set the emoji.
      await picker.locator(".mer-cover-swatch.mer-cover--forest").click();
      const emojiInput = page.locator('[data-testid="editor-cover-emoji-input"]');
      await emojiInput.fill(EMOJI);
      await emojiInput.blur();

      // The cover band + the emoji tile render.
      await expect(page.locator('[data-testid="editor-cover"]')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator('[data-testid="editor-cover-icon"]')).toHaveText(
        EMOJI,
        { timeout: 15000 }
      );
      // Let the optimistic save settle before we rely on it in the library below.
      await page.waitForTimeout(700);
      await page.screenshot({
        path: `${SHOT_DIR}/08-rich-editor-cover.png`,
        fullPage: false,
      });

      // --- Media: the 🖼 picker inserts an image by URL --------------------------
      // A UNIQUE URL per run: the collab doc is shared + persistent, so a fixed URL
      // would accumulate across runs and break a `toHaveCount(1)`.
      const imgUrl = `https://cdn.example.com/e2e-${Date.now()}.png`;
      const imgBefore = await pm.locator("img").count();
      const markerA = `mediaA ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(markerA);
      for (let i = 0; i < markerA.length; i++) {
        await page.keyboard.press("Shift+ArrowLeft");
      }
      const bubble = page.locator('[data-testid="editor-bubble-menu"]');
      await expect(bubble).toBeVisible({ timeout: 15000 });
      await bubble.locator('[data-testid="editor-media"]').click();
      await expect(
        page.locator('[data-testid="editor-media-pop"]')
      ).toBeVisible({ timeout: 15000 });
      await page.locator('[data-testid="editor-media-tab-image"]').click();
      await page.locator('[data-testid="editor-media-url-input"]').fill(imgUrl);
      await page.locator('[data-testid="editor-media-insert"]').click();
      // The AtriumImage node renders as an <img> carrying the (unique) URL.
      await expect(pm.locator(`img[src="${imgUrl}"]`)).toHaveCount(1, {
        timeout: 15000,
      });
      expect(await pm.locator("img").count()).toBeGreaterThan(imgBefore);

      // --- Callout: the 📣 toolbar button inserts an atriumCallout node ----------
      const calloutBefore = await pm.locator(".atrium-callout").count();
      const markerB = `callout ${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type(markerB);
      for (let i = 0; i < markerB.length; i++) {
        await page.keyboard.press("Shift+ArrowLeft");
      }
      await expect(bubble).toBeVisible({ timeout: 15000 });
      await bubble.locator('[data-testid="editor-callout"]').click();
      await page.locator('[data-testid="editor-callout-note"]').click();
      await expect
        .poll(() => pm.locator(".atrium-callout").count(), { timeout: 15000 })
        .toBeGreaterThan(calloutBefore);
      await page.screenshot({
        path: `${SHOT_DIR}/08-rich-callout.png`,
        fullPage: false,
      });

      // --- Library: the doc card now shows the emoji icon ------------------------
      await page.goto(`/atrium`);
      const docCard = page.locator(`a[href="/atrium/${DOC_ID}/edit"]`).first();
      await expect(docCard).toBeVisible({ timeout: 30000 });
      await expect(docCard.locator(".mer-icon-emoji")).toHaveText(EMOJI, {
        timeout: 15000,
      });
      await page.screenshot({
        path: `${SHOT_DIR}/08-rich-library-emoji.png`,
        fullPage: false,
      });
    } finally {
      await context.close();
    }
  });

  test("artifact library cards render the live-thumbnail scaffold (gradient fallback; scaled frame when the sandbox origin is configured)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto(`/atrium`);
      // Narrow to artifacts so the seeded artifact card is on the first page.
      await page
        .getByRole("group", { name: "Filter content" })
        .getByRole("button", { name: "Artifacts" })
        .click();

      const card = page
        .locator(`a[href="/atrium/${ARTIFACT_ID}/edit"]`)
        .first();
      await expect(card).toBeVisible({ timeout: 30000 });
      // The branded gradient preview (with the "Live artifact" pill) always renders
      // — it is the pre-load AND the fail-closed fallback when the sandbox origin
      // is unconfigured.
      await expect(card.locator(".mer-artifact-preview")).toBeVisible({
        timeout: 15000,
      });

      // The scaled live sandbox frame mounts ONLY when the sandbox origin is
      // configured (ArtifactThumbnail fails closed to the gradient otherwise). Gate
      // the strict assertion so a sandbox-less local run isn't a false failure.
      if (process.env.ATRIUM_E2E_HAS_SANDBOX === "true") {
        await expect(card.locator(".mer-artifact-thumb-frame")).toBeVisible({
          timeout: 30000,
        });
      }
      await page.screenshot({
        path: `${SHOT_DIR}/08-rich-artifact-thumb.png`,
        fullPage: false,
      });
    } finally {
      await context.close();
    }
  });

  test("the published reader renders slice-F callout blocks from the document body", async ({
    browser,
  }) => {
    test.skip(
      process.env.ATRIUM_E2E_HAS_S3 !== "true",
      "Document bodies render from the S3 source.md snapshot — set ATRIUM_E2E_HAS_S3=true with a rich-body fixture. The reader render pipeline itself is covered by tests/smoke/atrium-markdown-render.smoke.ts + atrium-embed-render.smoke.ts."
    );
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      const res = await page.goto(`/c/board-procedure-4040`);
      expect(res?.status()).toBe(200);
      await expect(
        page.locator(".atrium-content .atrium-callout").first()
      ).toBeVisible({ timeout: 30000 });
      await page.screenshot({
        path: `${SHOT_DIR}/08-rich-reader-callout.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
});
