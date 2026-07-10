import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Nexus workspace chat tools wiring (Atrium §1087) — chat can act on
 * the document/artifact open beside it.
 *
 * These assertions are DETERMINISTIC (they intercept the outbound chat request;
 * they do NOT depend on a live LLM deciding to call a tool):
 *  1. With a workspace open, the chat request body carries `workspaceId` — the
 *     server uses it to bind read/edit content tools.
 *  2. Switching the model with a workspace open PRESERVES `?workspace=` (the
 *     model-change reset used to drop it, silently closing the open document and
 *     its content tools).
 *
 * The live edit path (chat → agent bridge → live Yjs doc, chat → createVersion)
 * is proven separately; asserting it here would couple CI to a real model call.
 *
 * Reuses the standard editor seed (admin-owned doc) + the authed host :3100 server.
 */

const OBJ_SLUG = process.env.ATRIUM_EDITOR_E2E_SLUG ?? "atrium-editor-e2e";

async function pickAnyOtherModel(page: import("@playwright/test").Page) {
  await page.locator('button[aria-label="Select AI model"]').first().click({ timeout: 10_000 });
  const pop = page.locator('[data-radix-popper-content-wrapper], [role="dialog"]').last();
  // Pick the second listed model (any change triggers the model-change reset).
  await pop.locator("button").nth(1).click({ timeout: 5_000 });
}

test.describe("Nexus workspace chat tools (§1087, authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server + seeded doc"
  );

  test("chat request carries workspaceId, preserved across a model change", async ({ browser }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();

      const chatBodies: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/nexus/chat") && r.method() === "POST") {
          chatBodies.push(r.postData() ?? "");
        }
      });

      await page.goto(`/nexus?workspace=${OBJ_SLUG}`);
      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60_000 });

      // Switch the model — this triggers the clean-URL reset. It MUST keep the
      // workspace open (regression: it used to reload to a bare /nexus).
      await pickAnyOtherModel(page);
      await expect(page).toHaveURL(/workspace=/, { timeout: 20_000 });
      await expect(page.getByTestId("workspace-panel")).toBeVisible({ timeout: 60_000 });

      // Send a message and assert the outbound body carries the workspace id, so
      // the server binds the §1087 content tools for THIS object.
      const input = page
        .locator('textarea, [contenteditable="true"][role="textbox"], [data-testid="composer-input"]')
        .first();
      await input.click();
      await input.fill("hello");
      await page.keyboard.press("Enter");

      await expect
        .poll(() => chatBodies.some((b) => b.includes('"workspaceId"') && b.includes(OBJ_SLUG)), {
          timeout: 30_000,
        })
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
