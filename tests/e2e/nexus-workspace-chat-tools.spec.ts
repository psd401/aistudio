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
 *  2. Switching the Advanced family with a workspace open PRESERVES
 *     `?workspace=` and the open document/content tools.
 *
 * The live edit path (chat → agent bridge → live Yjs doc, chat → createVersion)
 * is proven separately; asserting it here would couple CI to a real model call.
 *
 * Reuses the standard editor seed (admin-owned doc) + the authed host :3100 server.
 */

const OBJ_SLUG = process.env.ATRIUM_EDITOR_E2E_SLUG ?? "atrium-editor-e2e";

const MOCK_CHAT_STREAM = [
  'data: {"type":"start","messageId":"e2e-workspace-assistant"}\n\n',
  'data: {"type":"text-start","id":"e2e-workspace-text"}\n\n',
  'data: {"type":"text-delta","id":"e2e-workspace-text","delta":"ok"}\n\n',
  'data: {"type":"text-end","id":"e2e-workspace-text"}\n\n',
  'data: {"type":"finish","finishReason":"stop"}\n\n',
  'data: [DONE]\n\n',
].join("");

async function chooseClaudeFamily(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Nexus routing mode" }).click();
  await page.getByTestId("nexus-mode-advanced").click();
  await page.getByTestId("nexus-family-anthropic").click();
}

test.describe("Nexus workspace chat tools (§1087, authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server + seeded doc"
  );

  test("chat request carries workspaceId, preserved across a family change", async ({ browser }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();

      const chatBodies: string[] = [];
      await page.route("**/api/nexus/chat", async (route) => {
        chatBodies.push(route.request().postData() ?? "");
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
          },
          body: MOCK_CHAT_STREAM,
        });
      }, { times: 1 });

      await page.goto(`/nexus?workspace=${OBJ_SLUG}`);
      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60_000 });

      // Change the Advanced family. The router control must not disturb the
      // workspace or fragile conversation runtime.
      await chooseClaudeFamily(page);
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
