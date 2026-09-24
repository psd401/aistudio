import { mkdir } from "node:fs/promises";
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
 * FS#165251 / #1733 — a freshly created Nexus project used to be chat-dead.
 *
 * Creating a project auto-provisions a private "project files" repository with
 * zero items, which derives readiness "empty". The pre-turn readiness gate
 * rejected the whole turn with REPOSITORY_NOT_READY, so the user got the
 * "Repository not ready" toast and no assistant reply, for every message, until
 * a document was uploaded and finished indexing.
 *
 * This flow creates a project, uploads nothing, and chats immediately.
 */
test.describe("Nexus project chat with an empty project repository", () => {
  test.describe.configure({ timeout: 240_000 });
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local E2E server and seeded users"
  );

  test("answers the first message instead of blocking on the empty project repository", async ({
    page,
  }, testInfo) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB
    );

    await createNexusProject(page, {
      name: `E2E empty project ${Date.now()}`,
      instructions: "Answer briefly. No documents have been uploaded yet.",
      timeout: 60_000,
    });
    // The private repository exists and is empty — exactly the reported state.
    await expect(page.getByText("Private project repository")).toBeVisible();

    await page.getByRole("button", { name: "New project chat" }).click();
    await expect(page).toHaveURL(
      /\/nexus\?conversationId=[0-9a-f-]+&projectId=[0-9a-f-]+$/,
      { timeout: 60_000 }
    );
    await page.waitForSelector('[data-testid="nexus-shell"]', {
      timeout: 60_000,
    });

    // The gate runs before the model is invoked, so the verdict is readable
    // from the chat response status regardless of provider behaviour.
    const chatResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/nexus/chat") &&
        response.request().method() === "POST",
      { timeout: 120_000 }
    );
    await sendMessage(page, "In one sentence, what is this project for?");
    const response = await chatResponse;

    // On failure the message carries the body, so a REPOSITORY_NOT_READY 409
    // (the #1733 regression) is named directly in the report.
    expect(response.status(), await response.text().catch(() => "")).toBe(200);
    await expect(page.getByText("Repository not ready")).toHaveCount(0);

    await waitForStreamingComplete(page, 180_000);
    const assistantMessage = page.locator('[data-role="assistant"]').last();
    await expect(assistantMessage).toBeVisible({ timeout: 180_000 });
    await expect(assistantMessage).not.toHaveText("");

    // Visual evidence for the PR (screenshot_dir default = .verification).
    await mkdir(".verification", { recursive: true });
    await page.screenshot({
      path: `.verification/nexus-project-empty-repository-chat-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});
