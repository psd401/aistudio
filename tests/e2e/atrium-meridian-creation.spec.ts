import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium Meridian creation flow + consolidated editor topbar
 * (Epic #1059 polish).
 *
 * Proves the README Interactions creation model + the Meridian topbar
 * consolidation the polish pass shipped:
 *  - "New doc" opens a BLANK sheet immediately — no create modal — and navigates
 *    straight to the editor, where the sheet title is inline-editable (the rename
 *    persists and lifts to the topbar breadcrumb).
 *  - "New page" opens a single agent-PROMPT field (not the old title form).
 *  - the unified Share control houses destination-specific publish and
 *    unpublish actions (replacing the old Publish ▾ split control).
 *  - (#1714) both artifact-create paths COMPLETE: "Start blank" lands in a
 *    loaded artifact editor with a v1, and "Build it for me" deep-links into
 *    the Nexus workspace with the prompt prefilled. The library posts the
 *    starter body base64-encoded (its <style> block trips the edge WAF when
 *    sent raw, and the rejected action left the dialog spinning forever). No
 *    WAF fronts this harness, so what these prove is the other half of the
 *    fix: the encoded body still round-trips into a version the editor loads.
 *
 * Gated behind PLAYWRIGHT_AUTH_ENABLED — see docs/guides/e2e-authenticated-
 * testing.md for the :3100 host-server prereqs.
 */

const SHOT_DIR = ".verification";

/**
 * Best-effort teardown for content a test created, so the shared local library
 * does not grow on every run (which slows unrelated library specs). Failures
 * are ignored on purpose — teardown must never mask the real assertion.
 */
async function deleteContent(
  page: import("@playwright/test").Page,
  id: string | undefined
): Promise<void> {
  if (!id) return;
  try {
    await page.request.delete(`/api/v1/content/${id}`);
  } catch {
    // Ignored on purpose — see the docblock.
  }
}

/** Open the library and click "New page", returning the open create dialog. */
async function openNewPageDialog(
  page: import("@playwright/test").Page
): Promise<import("@playwright/test").Locator> {
  await page.goto("/atrium");
  await expect(
    page.getByRole("heading", { name: "Content library" })
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "New page" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Atrium Meridian creation flow (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );

  test("New doc opens a blank sheet immediately with an inline-editable title", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/atrium");
      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible({ timeout: 60000 });

      // "New doc" navigates straight to a blank editor — NO create dialog.
      await page.getByRole("button", { name: "New doc" }).click();
      await page.waitForURL(/\/atrium\/[0-9a-f-]+\/edit/, { timeout: 30000 });
      await expect(page.locator(".mer-sheet")).toBeVisible({ timeout: 60000 });
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The sheet title is inline-editable; a rename lifts to the breadcrumb.
      const editableTitle = page.locator(".mer-sheet-title-edit");
      await expect(editableTitle).toBeVisible();
      await editableTitle.click();
      await page.keyboard.press("ControlOrMeta+a");
      const newTitle = `Renamed ${Date.now()}`;
      await page.keyboard.type(newTitle);
      // Blur commits (click into the body).
      await page.locator(".ProseMirror").click();
      await expect(page.locator(".mer-breadcrumb-title")).toHaveText(newTitle, {
        timeout: 15000,
      });
    } finally {
      await context.close();
    }
  });

  test("New page opens the single agent-prompt field", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/atrium");
      await expect(
        page.getByRole("heading", { name: "Content library" })
      ).toBeVisible({ timeout: 60000 });

      await page.getByRole("button", { name: "New page" }).click();
      // A single free-text prompt surface, not a title form.
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.locator('[data-slot="dialog-title"]')
      ).toHaveText("New interactive page");
      await expect(
        dialog.getByRole("textbox", {
          name: "Describe the artifact for the agent to build",
        })
      ).toBeVisible();
      // It is a PROMPT field, not the old single-line title input.
      await expect(dialog.locator("textarea.mer-prompt-field")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("editor Share consolidates destination + publish + unpublish", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      // A fresh owned doc (so canEdit → the Publish control renders).
      await page.goto("/atrium");
      await page.getByRole("button", { name: "New doc" }).click();
      await page.waitForURL(/\/atrium\/[0-9a-f-]+\/edit/, { timeout: 30000 });
      await expect(page.locator(".mer-editor-topbar")).toBeVisible({
        timeout: 60000,
      });

      // The single Share control opens a dialog that houses every destination
      // with its own publish/unpublish actions. The usability pass replaced the
      // Publish ▾ split control and its dropdown with this one entry point.
      await page.getByTestId("share-control").click();
      await expect(page.getByTestId("share-dest-intranet")).toBeVisible();
      await expect(page.getByTestId("share-publish-intranet")).toBeVisible();
      // Both the old naked native destination select and the Publish ▾ trigger
      // it lived behind are gone.
      await expect(
        page.getByTestId("publish-destination-select")
      ).toHaveCount(0);
      await expect(page.getByTestId("publish-menu-trigger")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

/**
 * The #1714 flows live in their own block so each describe stays under the
 * max-lines lint; they share the gate and helpers above.
 */
test.describe("Atrium library artifact create completes (#1714)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session — see docs/guides/e2e-authenticated-testing.md"
  );

  test("Start blank creates the page and opens its editor on a v1 (#1714)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    let page: import("@playwright/test").Page | undefined;
    let createdId: string | undefined;
    try {
      page = await context.newPage();
      const dialog = await openNewPageDialog(page);

      await dialog.getByRole("button", { name: "Start blank" }).click();
      // The click must go somewhere: on deployed environments this create was
      // blocked at the edge and the dialog looked like a no-op (#1714).
      await page.waitForURL(/\/atrium\/[0-9a-f-]+\/edit/, { timeout: 30000 });
      createdId = /\/atrium\/([0-9a-f-]+)\/edit/.exec(page.url())?.[1];
      expect(createdId).toBeTruthy();

      // The artifact canvas mounts on the decoded starter body: tabs render and
      // the version picker lists the v1 the seed created (bodyless creates had
      // no version, and the canvas opened on an error instead).
      await expect(page.getByRole("tab", { name: "Preview" })).toBeVisible({
        timeout: 60000,
      });
      await expect(page.getByTestId("artifact-version-select")).toBeVisible({
        timeout: 60000,
      });
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The stored v1 is the real starter markup, not the base64 wrapper —
      // i.e. the action decoded the transit encoding before the write.
      const lookup = await page.request.get(`/api/v1/content/${createdId}`);
      expect(lookup.status()).toBe(200);
      const body = (await lookup.json()) as {
        data?: { kind?: unknown; version?: { bodyInline?: unknown } | null };
      };
      expect(body.data?.kind).toBe("artifact");
      expect(typeof body.data?.version?.bodyInline).toBe("string");
      expect(body.data?.version?.bodyInline as string).toContain("<style>");

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-start-blank.png`,
        fullPage: false,
      });
    } finally {
      if (page) await deleteContent(page, createdId);
      await context.close();
    }
  });

  test("Build it for me creates the page and deep-links into the workspace chat (#1714)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await authenticateContext(context);
    let page: import("@playwright/test").Page | undefined;
    let createdId: string | undefined;
    try {
      page = await context.newPage();
      const dialog = await openNewPageDialog(page);

      // "E2E " prefix so db:cleanup:e2e can reclaim it if teardown is skipped.
      const prompt = `E2E Build ${Date.now()}`;
      await dialog
        .getByRole("textbox", {
          name: "Describe the artifact for the agent to build",
        })
        .fill(prompt);
      await dialog.getByRole("button", { name: "Build it for me" }).click();

      // The create resolves and the library hands off to Nexus with the new
      // artifact bound as the workspace. (The `draft` param is consumed and
      // stripped by the composer prefill, so match on `workspace` only.)
      await page.waitForURL(/\/nexus\?.*workspace=[0-9a-f-]+/, {
        timeout: 30000,
      });
      createdId =
        new URL(page.url()).searchParams.get("workspace") ?? undefined;
      expect(createdId).toBeTruthy();

      // Both halves of the §17 hand-off render: the artifact in the workspace
      // panel, and the prompt PREFILLED (never auto-sent) in the composer.
      await expect(page.getByTestId("workspace-panel")).toBeVisible({
        timeout: 60000,
      });
      const composer = page.locator('[aria-label="Message input"]');
      await expect(composer).toBeVisible({ timeout: 60000 });
      await expect(composer).toHaveValue(prompt, { timeout: 30000 });

      await page.screenshot({
        path: `${SHOT_DIR}/atrium-library-build-it-for-me.png`,
        fullPage: false,
      });
    } finally {
      if (page) await deleteContent(page, createdId);
      await context.close();
    }
  });

});
