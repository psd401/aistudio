import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";
import { mkdirSync } from "node:fs";

/**
 * E2E (gated): Nexus workspace chat reads + edits the LIVE Atrium document (§1087).
 *
 * This is the functional half of the §1087 fix: unlike
 * nexus-workspace-chat-tools.spec.ts (which deterministically asserts the outbound
 * `workspaceId` without a model), these flows drive a REAL model through the chat
 * so the read/edit content tools actually fire against the live collaborative doc:
 *
 *  (a) READ-LIVE — a unique marker typed into the panel editor (so it lives ONLY
 *      in the live Yjs doc, never in the stale seed projection) is reflected back
 *      when the chat is asked what the document says. Proves the read tool reads
 *      the live doc, not the frozen `atrium_doc_state.markdown`.
 *  (b) APPEND — asking the chat to add a line writes it into the live document,
 *      appearing in the panel on the PURPLE (agent) provenance rail.
 *  (c) NEW-DOC — a title-only (empty-body) document gets an intro written via chat
 *      with NO permission/refusal (the old bug: an empty projection surfaced as
 *      bodyUnavailable, which the model narrated as "I don't have access").
 *
 * PREREQUISITES (why this is gated — it is NOT run in CI):
 *  - Host dev server via `bun run server.ts` on :3100 (the collab WS lives in the
 *    custom server) with PLAYWRIGHT_AUTH_ENABLED=true and a chat-capable model
 *    configured (docs/guides/e2e-authenticated-testing.md).
 *  - Seed: tests/e2e/fixtures/atrium-editor-seed.sql (admin-owned docs → canEdit).
 */

const DOC_ID = process.env.ATRIUM_EDITOR_E2E_ID ?? "a7100000-0000-4000-8000-000000006060";
const TITLE_ONLY_ID =
  process.env.ATRIUM_TITLEONLY_E2E_ID ?? "a7100000-0000-4000-8000-000000008080";

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? ".verification";
mkdirSync(SHOT_DIR, { recursive: true });

/** Send a chat message and wait for the assistant to finish its reply. */
async function sendChat(page: import("@playwright/test").Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.click();
  await composer.fill(text);
  // Send (the button flips to "Stop generating" while streaming, then back).
  await page.getByRole("button", { name: "Send message" }).click();
  // The assistant is done when the composer's Send button is available again and
  // an assistant message exists. Generous timeout for a cold model + tool round-trip.
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 120_000 });
}

test.describe("Nexus workspace chat — live Atrium read/edit (§1087, authenticated)", () => {
  // A real model call + a tool round-trip + a live Yjs edit can take well over
  // the default 60s per-test budget on a cold dev server; give each flow headroom.
  test.describe.configure({ timeout: 180_000 });

  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server (collab WS) + a chat model + seeded docs — see docs/guides/e2e-authenticated-testing.md"
  );

  test("(a) read-live: chat reflects a paragraph typed live into the panel", async ({ browser }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto(`/nexus?workspace=${DOC_ID}`);

      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60_000 });
      const pm = panel.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60_000 });

      // Type a UNIQUE marker into the live doc. It exists only in the Yjs doc —
      // NOT in the seed projection — so the chat reflecting it proves a live read.
      const marker = `Pineapple-${Date.now()}`;
      await pm.click();
      await page.keyboard.press("End");
      await page.keyboard.type(`The secret codeword is ${marker}.`);
      await expect(pm).toContainText(marker, { timeout: 30_000 });

      await sendChat(page, "Read the open document and tell me the exact secret codeword it contains.");

      // The assistant's reply must echo the codeword it could only have obtained by
      // reading the LIVE document via read_workspace_content.
      await expect(page.locator('[data-role="assistant"]').last()).toContainText(marker, {
        timeout: 120_000,
      });

      await page.screenshot({ path: `${SHOT_DIR}/nexus-workspace-chat-read-live.png`, fullPage: true });
    } finally {
      await context.close();
    }
  });

  test("(b) append: chat writes a line that lands on the purple (agent) rail", async ({ browser }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto(`/nexus?workspace=${DOC_ID}`);

      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60_000 });
      const pm = panel.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60_000 });

      await sendChat(page, "Add a line to the document that says exactly: Reviewed by AI");

      // The edit landed LIVE in the panel: the text appears AND carries the agent
      // (purple) provenance rail — the chat edit is attributed to the assistant.
      await expect(pm).toContainText("Reviewed by AI", { timeout: 120_000 });
      await expect(panel.locator('span[data-author="agent"]').first()).toBeVisible({ timeout: 120_000 });
      await expect(panel.locator('.atrium-rail-block[data-author="agent"]').first()).toBeVisible({
        timeout: 120_000,
      });

      await page.screenshot({ path: `${SHOT_DIR}/nexus-workspace-chat-append-agent-rail.png`, fullPage: true });
    } finally {
      await context.close();
    }
  });

  test("(c) new-doc: a title-only document gets an intro via chat with no refusal", async ({ browser }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto(`/nexus?workspace=${TITLE_ONLY_ID}`);

      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60_000 });
      const pm = panel.locator(".ProseMirror");
      await expect(pm).toHaveAttribute("contenteditable", "true", { timeout: 60_000 });

      const sentinel = `IntroSentinel-${Date.now()}`;
      await sendChat(
        page,
        `The open document is empty. Write a short introductory paragraph for it and include the token ${sentinel} verbatim.`
      );

      // The intro was written into the (previously empty) live document — the model
      // did NOT refuse for lack of access (the §1087 bug).
      await expect(pm).toContainText(sentinel, { timeout: 120_000 });
      await expect(panel.locator('.atrium-rail-block[data-author="agent"]').first()).toBeVisible({
        timeout: 120_000,
      });

      // The assistant reply must not contain a permission/refusal phrase.
      const reply = (await page.locator('[data-role="assistant"]').last().innerText()).toLowerCase();
      expect(reply).not.toMatch(/don'?t have (access|permission)|can'?t (access|read|edit)|no access|not able to access/);

      await page.screenshot({ path: `${SHOT_DIR}/nexus-workspace-chat-new-doc.png`, fullPage: true });
    } finally {
      await context.close();
    }
  });
});
