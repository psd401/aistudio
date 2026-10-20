import type { Locator, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { validatedFs } from "@/lib/filesystem/validated-fs";

/**
 * E2E (gated): flow `nexus-image-reload` — a generated image still renders
 * after a reload (Issue #1900).
 *
 * The reported gap: of 375 staff reading Nexus between Aug and Oct 2026, about
 * 35 hit image problems — images that never displayed, or displayed once and
 * broke after a reload. Two causes:
 *  - the reload path re-signed the image with the DATABASE `S3_BUCKET` setting
 *    while `storeImageInS3` had written it to `DOCUMENTS_BUCKET_NAME`, and the
 *    two are not guaranteed to match;
 *  - the browser was handed a raw S3 presigned URL, which expires in an hour
 *    and fails intermittently with `InvalidToken`.
 *
 * Both are fixed by serving every generated image from the authenticated
 * `/api/images/[...key]` route, which re-checks ownership per request and signs
 * with the SAME resolver that stored the object.
 *
 * The deterministic halves are unit-tested:
 *  - bucket resolver + reload URL: tests/unit/nexus-generated-image-serving.test.ts
 *  - the failed-image fallback: tests/unit/markdown-image-fallback.test.tsx
 *  - NO_IMAGE explanations: tests/unit/nexus-no-image-result.test.ts
 *  - attachment routing: lib/nexus/model-router/__tests__/router.test.ts
 *
 * What only this spec can show: a real image model produces an image, the
 * browser actually decodes those bytes, and the SAME url still decodes after a
 * full document load — which a one-hour presigned URL in a persisted message
 * could not meet.
 *
 * PREREQUISITES (why this is gated — it is NOT run in CI):
 *  - Host dev server (`bun run server.ts`) with PLAYWRIGHT_AUTH_ENABLED=true and
 *    an accessible image model configured (docs/guides/e2e-authenticated-testing.md).
 *  - DOCUMENTS_BUCKET_NAME set and writable by the app's AWS credentials.
 */

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? ".verification";
validatedFs.mkdirSync(SHOT_DIR, { recursive: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The symptom the ticket reported: being told images are impossible. */
const CANNOT_MAKE_IMAGES = [
  /can(?:no|')?t (?:create|generate|make|produce) (?:an )?image/i,
  /unable to (?:create|generate|produce) (?:an )?image/i,
  /I don'?t have the ability to (?:create|generate) images/i,
];

/** Send a chat message and wait for the assistant to finish its reply. */
async function sendChat(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: 180_000,
  });
}

/** The last image inside an assistant reply. */
function generatedImage(page: Page): Locator {
  return page.locator('[data-role="assistant"] img').last();
}

/**
 * Assert the image is served by the authenticated route AND actually decoded.
 *
 * `naturalWidth > 0` is the load-bearing check: a broken `<img>` is still in
 * the DOM and still "visible" to Playwright, which is exactly how this bug
 * stayed invisible to earlier assertions.
 */
async function expectRenderedImage(page: Page): Promise<string> {
  const image = generatedImage(page);
  await expect(image).toBeVisible({ timeout: 180_000 });

  const src = await image.getAttribute("src");
  expect(src, "image has a src").toBeTruthy();
  // Never a raw presigned S3 URL — that is the URL that expires and 403s.
  expect(src).toMatch(/^\/api\/images\/v2\/generated-images\//);
  expect(src).not.toMatch(/X-Amz-Signature/i);

  await expect
    .poll(
      () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      { timeout: 60_000, message: "the browser decoded the image bytes" }
    )
    .toBeGreaterThan(0);

  // The #1900 fallback must NOT be showing.
  await expect(page.getByText(/Image unavailable/)).toHaveCount(0);

  return src as string;
}

test.describe("Nexus generated images survive a reload (#1900)", () => {
  // A real image-model call plus an S3 upload and a reload round-trip on a cold
  // dev server needs well over the default per-test budget.
  test.describe.configure({ timeout: 300_000 });

  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated host dev server — see docs/guides/e2e-authenticated-testing.md"
  );
  // Every image model needs a Google or OpenAI key. Without one the app
  // correctly refuses ("Image generation is not available…"), so this spec
  // would fail the pre-push gate on any machine that has no image key.
  test.skip(
    !process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY,
    "Requires GOOGLE_API_KEY or OPENAI_API_KEY so an image model is accessible"
  );

  test("an image renders when generated and again after the page reloads", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/nexus");

      await sendChat(
        page,
        "Generate an image of a red bicycle leaning against a white wall."
      );

      const reply = page.locator('[data-role="assistant"]').last();
      const replyText = await reply.innerText();
      for (const pattern of CANNOT_MAKE_IMAGES) {
        expect(replyText).not.toMatch(pattern);
      }

      const before = await expectRenderedImage(page);
      await page.screenshot({
        path: `${SHOT_DIR}/nexus-image-reload-before.png`,
        fullPage: true,
      });

      // Reopen the conversation the way a user does from the sidebar.
      // Nexus keeps a new conversation's id in React state rather than the URL,
      // so re-visiting `page.url()` would start a BLANK conversation and this
      // test would pass for the wrong reason. The id is in the image key.
      const conversationId = before.split("/")[4];
      expect(conversationId).toMatch(UUID);
      await page.goto(`/nexus?id=${conversationId}`);

      const after = await expectRenderedImage(page);
      // The same durable URL, not a freshly minted presigned one.
      expect(after).toBe(before);

      await page.screenshot({
        path: `${SHOT_DIR}/nexus-image-reload-after.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
});
