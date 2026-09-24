/**
 * #1791 visual evidence + guard for the two authoring-flow surfaces this issue
 * changed that a person actually looks at:
 *
 *  - finding 5: the "New interactive page" dialog now says a page can show live
 *    district data, and whose data each viewer sees, with an opt-in that creates
 *    the starter in `query` mode.
 *  - finding 1/2: the artifact rail's "Ask the agent" card now continues the
 *    conversation that already knows the artifact, with an explicit escape to
 *    start a fresh one — and its Ask button sends rather than just prefilling.
 *
 * Authenticated (a minted session): both surfaces are behind the
 * `atrium-content` capability.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

interface ContentResponse {
  data?: { id?: unknown; title?: unknown; slug?: unknown };
}

const AUTH_ENABLED = process.env.PLAYWRIGHT_AUTH_ENABLED === "true";

test.describe("Atrium authoring flow (#1791)", () => {
  test.skip(!AUTH_ENABLED, "needs a minted session (PLAYWRIGHT_AUTH_ENABLED)");
  test.use({ storageState: "tests/e2e/.auth/user-a.json" });

  test("the create dialog explains live district data and offers the opt-in", async ({
    page,
  }) => {
    await page.goto("/atrium");
    await page.getByRole("button", { name: /new page/i }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The capability nothing in the product used to mention.
    await expect(
      dialog.getByText(/Dashboards can show live district data/i)
    ).toBeVisible();
    // ...and the permission rule, which is the part that makes it trustworthy.
    await expect(
      dialog.getByText(/Each viewer sees what their own permissions allow/i)
    ).toBeVisible();

    const optIn = dialog.getByRole("checkbox", { name: /use live psd data/i });
    await expect(optIn).toBeVisible();
    // Default OFF: a viewer-scoped query bridge is the author's choice.
    await expect(optIn).not.toBeChecked();

    await page.screenshot({
      path: ".verification/1791-create-dialog-live-data.png",
      fullPage: false,
    });

    await optIn.check();
    await expect(optIn).toBeChecked();
  });

  test("an artifact's Ask card offers a start-over escape, and a rename re-slugs it", async ({
    browser,
  }) => {
    // Create the artifact this test needs rather than hoping the library's
    // first card is one (a seeded library is overwhelmingly documents).
    const title = `E2E 1791 ${crypto.randomUUID()}`;
    const renamed = `${title} renamed`;
    const context = await browser.newContext();
    let page: Page | undefined;
    let contentId: string | undefined;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      const created = await page.request.post("/api/v1/content", {
        data: {
          kind: "artifact",
          title,
          body: `<p>#1791 evidence probe for ${title}</p>`,
          bodyFormat: "html",
        },
      });
      expect(created.status()).toBe(201);
      contentId = ((await created.json()) as ContentResponse).data?.id as string;
      expect(typeof contentId).toBe("string");

      await page.goto(`/atrium/${contentId}/edit`);
      const card = page.getByTestId("artifact-ask-agent");
      await expect(card).toBeVisible({ timeout: 30_000 });
      // #1791 finding 1: Ask continues the artifact's existing chat, so starting
      // over has to stay reachable in one click.
      await expect(
        card.getByRole("button", { name: /start a new chat instead/i })
      ).toBeVisible();

      await card.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: ".verification/1791-ask-agent-card.png",
        fullPage: false,
      });

      // #1791 finding 3: a rename of a never-published item regenerates its slug
      // from the new title (it used to keep the first prompt's slug forever).
      const before = (await (
        await page.request.get(`/api/v1/content/${contentId}`)
      ).json()) as ContentResponse;
      const patched = await page.request.patch(`/api/v1/content/${contentId}`, {
        data: { title: renamed },
      });
      expect(patched.ok()).toBe(true);
      const after = (await (
        await page.request.get(`/api/v1/content/${contentId}`)
      ).json()) as ContentResponse;
      expect(after.data?.title).toBe(renamed);
      expect(after.data?.slug).not.toBe(before.data?.slug);
      expect(after.data?.slug).toMatch(/renamed$/);

      // Renaming to the SAME title must not churn the slug to `-1` (the row's
      // own slug is not a collision).
      await page.request.patch(`/api/v1/content/${contentId}`, {
        data: { title: renamed },
      });
      const again = (await (
        await page.request.get(`/api/v1/content/${contentId}`)
      ).json()) as ContentResponse;
      expect(again.data?.slug).toBe(after.data?.slug);
    } finally {
      if (page && contentId) {
        const res = await page.request.delete(`/api/v1/content/${contentId}`);
        expect.soft(res.ok(), `cleanup HTTP ${res.status()}`).toBe(true);
      }
      await context.close();
    }
  });
});
