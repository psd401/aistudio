import { mkdir } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";
import {
  createNexusProject,
  sendMessage,
  waitForStreamingComplete,
} from "./nexus/utils";

/**
 * E2E (gated): flow `nexus-bound-image` — an image request in a Project
 * conversation reaches an image model (#1900 follow-up, PR #1950).
 *
 * A Project binding adds its repository search tools to every turn, so "draw
 * a cat" used to count as a tool turn and went to a text model that cannot
 * draw. Once routed correctly, a 400 ("Image generation does not use project
 * repository context") refused it anyway. Now the image path runs through the
 * standard conversation setup, keeps the Project binding, stores its
 * repository bindings, and applies the Project instructions to the prompt.
 *
 * What this spec proves end to end: the chat request succeeds, a real image
 * is generated and DECODED from the authenticated proxy, and a text follow-up
 * in the same Project conversation still works afterwards.
 *
 * The routing, binding and prompt rules are unit-tested:
 *  - lib/nexus/model-router/__tests__/router.test.ts (bound image suite)
 *  - tests/unit/lib/nexus/routing-tool-names.test.ts
 *  - tests/unit/api/nexus/image-generation-handler.test.ts
 *
 * PREREQUISITES (gated — it is NOT run in CI): the authenticated host dev
 * server (docs/guides/e2e-authenticated-testing.md) and an accessible image
 * model — GOOGLE_API_KEY or OPENAI_API_KEY in the runner's env, or
 * E2E_IMAGE_GENERATION=true when the server reads the key from settings.
 */

/** Width of the decoded bitmap; 0 for a broken image still in the DOM. */
function naturalWidth(image: Locator): Promise<number> {
  return image.evaluate((node) => (node as HTMLImageElement).naturalWidth);
}

function chatPost(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/api/nexus/chat") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
}

test.describe("Nexus image request in a Project conversation", () => {
  test.describe.configure({ timeout: 360_000 });
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local E2E server and seeded users"
  );
  test.skip(
    process.env.E2E_IMAGE_GENERATION !== "true" &&
      !process.env.GOOGLE_API_KEY &&
      !process.env.OPENAI_API_KEY,
    "Requires an accessible image model: set GOOGLE_API_KEY or OPENAI_API_KEY, or E2E_IMAGE_GENERATION=true when the key is in database settings"
  );

  test("generates an image and then answers a text follow-up", async ({
    page,
  }, testInfo) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB
    );
    await createNexusProject(page, {
      name: `E2E bound image ${Date.now()}`,
      instructions: "Every image uses a plain white background.",
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "New project chat" }).click();
    await expect(page).toHaveURL(/projectId=[0-9a-f-]+/, { timeout: 60_000 });
    await page.waitForSelector('[data-testid="nexus-shell"]', {
      timeout: 60_000,
    });

    // 1. The image turn: no 400 project refusal, a real image from the proxy.
    const imageResponse = chatPost(page);
    await sendMessage(page, "Generate an image of a red bicycle.");
    const imageStatus = await imageResponse;
    expect(imageStatus.status(), await imageStatus.text().catch(() => "")).toBe(200);

    const image = page.locator('[data-role="assistant"] img').last();
    await expect(image).toBeVisible({ timeout: 180_000 });
    await expect(image).toHaveAttribute("src", /^\/api\/images\/v2\/generated-images\//);
    await expect
      .poll(() => naturalWidth(image), {
        timeout: 60_000,
        message: "the browser decoded the image bytes",
      })
      .toBeGreaterThan(0);
    await expect(page.getByText(/Image unavailable/)).toHaveCount(0);

    // 2. A text follow-up in the same Project conversation still works: the
    //    conversation kept its binding and its stored repository bindings.
    const followUp = chatPost(page);
    await sendMessage(page, "In one sentence, what is this project for?");
    const followUpStatus = await followUp;
    expect(followUpStatus.status(), await followUpStatus.text().catch(() => "")).toBe(200);
    await waitForStreamingComplete(page, 180_000);
    const reply = page.locator('[data-role="assistant"]').last();
    await expect(reply).not.toHaveText("");

    await mkdir(".verification", { recursive: true });
    await page.screenshot({
      path: `.verification/nexus-bound-image-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});
