/**
 * #1790 visual evidence + guard for the sharing surfaces a live-data artifact
 * author actually looks at:
 *
 *  - fix 1: the Share dialog opens with the live-data notice for a `query`-mode
 *    artifact, and annotates the Public level once it is selected — the two
 *    things the dialog used to say nothing about.
 *  - fix 3: the About rail carries a "Data" row, and the topbar pill no longer
 *    says "LIVE ARTIFACT" on a Draft (it says "INTERACTIVE").
 *
 * A `records`-mode artifact is the negative control: the same dialog, on the
 * same route, says none of it.
 *
 * Authenticated (a minted session): the editor is behind `atrium-content`, and
 * the mode is set through `PATCH /api/v1/content/{id}` as the owner.
 */

import { test, expect, type Page } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

interface ContentResponse {
  data?: { id?: unknown; dataAccess?: unknown };
}

const AUTH_ENABLED = process.env.PLAYWRIGHT_AUTH_ENABLED === "true";

/** Create an artifact in the requested bridge mode, owned by the session user. */
async function createArtifact(
  page: Page,
  title: string,
  dataAccess: "query" | "records"
): Promise<string> {
  const created = await page.request.post("/api/v1/content", {
    data: {
      kind: "artifact",
      title,
      body: `<p>#1790 evidence probe for ${title}</p>`,
      bodyFormat: "html",
    },
  });
  expect(created.status()).toBe(201);
  const contentId = ((await created.json()) as ContentResponse).data
    ?.id as string;
  expect(typeof contentId).toBe("string");

  // `records` is the default, so only `query` needs the PATCH — but assert the
  // resulting mode either way so a silently-ignored update cannot pass as proof.
  if (dataAccess === "query") {
    const patched = await page.request.patch(`/api/v1/content/${contentId}`, {
      data: { dataAccess },
    });
    expect(patched.ok()).toBe(true);
  }
  const after = (await (
    await page.request.get(`/api/v1/content/${contentId}`)
  ).json()) as ContentResponse;
  expect(after.data?.dataAccess).toBe(dataAccess);
  return contentId;
}

test.describe("Atrium live-data sharing (#1790)", () => {
  test.skip(!AUTH_ENABLED, "needs a minted session (PLAYWRIGHT_AUTH_ENABLED)");

  test("a query-mode artifact's Share dialog and rail say what it shares", async ({
    browser,
  }) => {
    const title = `E2E 1790 query ${crypto.randomUUID()}`;
    const context: BrowserContext = await browser.newContext();
    let page: Page | undefined;
    let contentId: string | undefined;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      contentId = await createArtifact(page, title, "query");

      await page.goto(`/atrium/${contentId}/edit`);

      // Fix 3: the pill no longer claims "LIVE" on a Draft, and the About rail
      // names the data instead of describing the page only by its author.
      const pill = page.getByTestId("artifact-live-pill");
      await expect(pill).toBeVisible({ timeout: 60_000 });
      await expect(pill).toHaveText(/INTERACTIVE/);
      await expect(pill).not.toHaveText(/LIVE ARTIFACT/);

      const rail = page.getByTestId("artifact-meta-rail");
      await expect(rail).toContainText("Live PSD data (as viewer)");
      await expect(page.getByTestId("artifact-data-note")).toContainText(
        /their own district permissions/i
      );
      await page.screenshot({
        path: ".verification/1790-artifact-rail-data-row.png",
        fullPage: false,
      });

      // Fix 1: open Share. The notice is the first thing in the dialog.
      await page.getByRole("button", { name: /^Share/ }).first().click();
      const notice = page.getByTestId("share-live-data-notice");
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText("This page shows live PSD data");
      await expect(notice).toContainText(
        "only what their own district permissions allow"
      );
      await page.screenshot({
        path: ".verification/1790-share-dialog-live-data-notice.png",
        fullPage: false,
      });

      // The Public caveat is an annotation on a choice, so it appears only once
      // Public is actually chosen — not before.
      await expect(
        page.getByTestId("share-live-data-public-warning")
      ).toHaveCount(0);
      // The level picker is a Radix Select (a combobox BUTTON + a portalled
      // listbox), not a native <select>, so it is driven by click → option
      // rather than `selectOption`. It must be addressed by accessible name:
      // the editor behind the dialog has its own `Version` combobox, which is
      // first in DOM order, so an unnamed `.first()` opens the wrong control.
      await page.getByRole("combobox", { name: "Level" }).click();
      await page.getByRole("option", { name: "Public" }).click();
      const warning = page.getByTestId("share-live-data-public-warning");
      await expect(warning).toBeVisible();
      await expect(warning).toContainText(
        "Live data doesn't load on the public web"
      );
      await page.screenshot({
        path: ".verification/1790-share-public-live-data-warning.png",
        fullPage: false,
      });
    } finally {
      if (page && contentId) {
        const res = await page.request.delete(`/api/v1/content/${contentId}`);
        expect.soft(res.ok(), `cleanup HTTP ${res.status()}`).toBe(true);
      }
      await context.close();
    }
  });

  test("a records-mode artifact's Share dialog says none of it", async ({
    browser,
  }) => {
    const title = `E2E 1790 records ${crypto.randomUUID()}`;
    const context: BrowserContext = await browser.newContext();
    let page: Page | undefined;
    let contentId: string | undefined;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      contentId = await createArtifact(page, title, "records");

      await page.goto(`/atrium/${contentId}/edit`);
      await expect(page.getByTestId("artifact-live-pill")).toBeVisible({
        timeout: 60_000,
      });
      // The negative control for the rail row: named, but not as live data.
      await expect(page.getByTestId("artifact-meta-rail")).not.toContainText(
        "Live PSD data"
      );

      await page.getByRole("button", { name: /^Share/ }).first().click();
      await expect(page.getByTestId("share-link-url")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("share-live-data-notice")).toHaveCount(0);
    } finally {
      if (page && contentId) {
        const res = await page.request.delete(`/api/v1/content/${contentId}`);
        expect.soft(res.ok(), `cleanup HTTP ${res.status()}`).toBe(true);
      }
      await context.close();
    }
  });
});
