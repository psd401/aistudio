/**
 * #1793 — Nexus workspace panel layout, plus the two Atrium surfaces the same
 * review flagged. Every assertion is a MEASUREMENT of the bug that was filed,
 * not a snapshot, so a regression fails on numbers rather than on pixels:
 *
 *  - finding 1: the split is resizable and defaults to half the content area,
 *    instead of a fixed 44% that rendered dashboards at phone width.
 *  - finding 2: the composer's control dock no longer overflows (and clips) the
 *    narrowed chat column — "Connect" was rendered as "Con…". Measured before
 *    the fix: dock scrollWidth 431 inside a clientWidth of 371. The second half
 *    of that finding (a horizontally scrolled textarea) did NOT reproduce —
 *    the input measured scrollWidth == clientWidth == 371, scrollLeft 0,
 *    `white-space: pre-wrap` — so nothing was changed for it.
 *  - finding 3: the starter cards fit their cells, and a bound workspace swaps
 *    the generic classroom starters for artifact-relevant ones.
 *  - finding 4: no control in the Share dialog renders outside its panel. This
 *    one did NOT reproduce on `dev` — the dialog's width fixes (`data-mer-size`
 *    + the `min-width: 0` flex rows, both from 134b5c0f4, 2026-08-02) had not
 *    reached the prod build the review ran against. A probe that forced the
 *    dialog's grid children back to `min-width: auto` still produced zero
 *    strays, so nothing was changed here; this stays as a regression guard on
 *    the behaviour the fixes already give.
 *  - finding 5: the chrome-free artifact viewport offers a way back.
 *
 * Authenticated (minted session) — every surface is behind `atrium-content`.
 * Runs at 1255px, the window width the issue was filed from.
 */

import { test, expect, type Page } from "@playwright/test";

const AUTH_ENABLED = process.env.PLAYWRIGHT_AUTH_ENABLED === "true";

/** The window the #1793 review used. */
const REVIEW_VIEWPORT = { width: 1255, height: 900 };

const ARTIFACT_BODY =
  "<html><body><h1>1793 layout fixture</h1></body></html>";

/**
 * Runs IN THE PAGE: the labels of every button drawn outside `root`'s own box.
 * Declared at module scope (not inline) so it stays one callback deep.
 */
function collectStrayControlLabels(root: Element): string[] {
  const panel = root.getBoundingClientRect();
  const out: string[] = [];
  for (const button of Array.from(root.querySelectorAll("button"))) {
    const r = button.getBoundingClientRect();
    // 1px tolerance for sub-pixel rounding.
    if (r.right > panel.right + 1 || r.left < panel.left - 1) {
      out.push(button.textContent?.trim() ?? "");
    }
  }
  return out;
}

async function createArtifact(page: Page): Promise<string> {
  const created = await page.request.post("/api/v1/content", {
    data: {
      kind: "artifact",
      title: `E2E 1793 ${crypto.randomUUID()}`,
      body: ARTIFACT_BODY,
    },
  });
  expect(created.ok()).toBeTruthy();
  const json = (await created.json()) as { data?: { id?: string } };
  const id = json?.data?.id;
  expect(typeof id).toBe("string");
  return id as string;
}

test.describe("Nexus workspace panel layout (#1793)", () => {
  test.skip(!AUTH_ENABLED, "needs a minted session (PLAYWRIGHT_AUTH_ENABLED)");
  test.use({
    storageState: "tests/e2e/.auth/user-a.json",
    viewport: REVIEW_VIEWPORT,
  });

  test("the panel takes half the split, resizes by drag, and remembers the width", async ({
    page,
  }) => {
    const id = await createArtifact(page);
    await page.goto(`/nexus?workspace=${id}`);

    const panel = page.getByTestId("workspace-panel");
    await expect(panel).toBeVisible({ timeout: 60_000 });

    const splitWidth = async () =>
      panel.evaluate(
        (el) => el.parentElement?.getBoundingClientRect().width ?? 0
      );
    const panelWidth = async () =>
      panel.evaluate((el) => el.getBoundingClientRect().width);

    const container = await splitWidth();
    const initial = await panelWidth();
    // "At least half the content area" — the fixed 44% this replaced put a
    // 4-KPI dashboard into one phone-width column.
    expect(initial).toBeGreaterThanOrEqual(container / 2 - 2);
    // ...and never so wide that the chat stops being a usable column.
    expect(container - initial).toBeGreaterThanOrEqual(320);

    // Drag the handle 60px to the LEFT — the panel grows by that much. (Not
    // further: the split also reserves a 320px minimum for the chat column, and
    // at this viewport that ceiling is only ~85px above the default.)
    const handle = page.getByTestId("workspace-resize-handle");
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 60, startY, { steps: 10 });
    await page.mouse.up();

    const widened = await panelWidth();
    expect(widened).toBeGreaterThan(initial + 50);

    // The width survives a reload (persisted, not per-mount state).
    await page.reload();
    await expect(panel).toBeVisible({ timeout: 60_000 });
    const afterReload = await panelWidth();
    expect(Math.abs(afterReload - widened)).toBeLessThan(6);

    await page.screenshot({
      path: ".verification/1793-workspace-panel-resized.png",
      fullPage: false,
    });
  });

  test("the composer dock and the starter cards fit the narrowed chat column", async ({
    page,
  }) => {
    const id = await createArtifact(page);
    await page.goto(`/nexus?workspace=${id}`);
    await expect(page.getByTestId("workspace-panel")).toBeVisible({
      timeout: 60_000,
    });

    // finding 2 — the control dock used to need ~430px inside a ~371px column,
    // and the composer clips overflow, so "Connect" was cut to "Con…".
    const connect = page.getByTestId("nexus-mcp-control");
    await expect(connect).toBeVisible();
    const dockOverflow = await connect.evaluate((el) => {
      const dock = el.parentElement as HTMLElement;
      return dock.scrollWidth - dock.clientWidth;
    });
    expect(dockOverflow).toBeLessThanOrEqual(0);
    // The whole button, not a clipped stub, sits inside the composer.
    const connectFits = await connect.evaluate((el) => {
      const dock = el.parentElement as HTMLElement;
      return (
        el.getBoundingClientRect().right <=
        dock.getBoundingClientRect().right + 1
      );
    });
    expect(connectFits).toBe(true);
    await expect(connect).toContainText("Connect");

    // finding 3 — workspace-relevant starters, and they fit their cells.
    const starters = page.getByRole("button", { name: /Explain the page I have open/i });
    await expect(starters).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Help me create a lesson plan/i })
    ).toHaveCount(0);

    const gridOverflow = await starters.evaluate((el) => {
      const grid = el.closest(".grid") as HTMLElement;
      return grid.scrollWidth - grid.clientWidth;
    });
    expect(gridOverflow).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: ".verification/1793-composer-and-starters.png",
      fullPage: false,
    });
  });

  test("no Share dialog control renders outside the dialog panel", async ({
    page,
  }) => {
    const id = await createArtifact(page);
    await page.goto(`/atrium/${id}/edit`);

    await page.getByRole("button", { name: /share/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId("share-link-url")).toBeVisible();

    // The white panel is the dialog box itself; every control has to be inside
    // it. #1793 reported Copy, Publish, the connector Send buttons and Save all
    // sitting past the right edge — see the file header: that is prod build
    // drift, not live behaviour, and this pins it so it cannot come back.
    const strays = await dialog.evaluate(collectStrayControlLabels);
    expect(strays).toEqual([]);

    const bodyOverflow = await dialog.evaluate(
      (root) => root.scrollWidth - root.clientWidth
    );
    expect(bodyOverflow).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: ".verification/1793-share-dialog.png",
      fullPage: false,
    });
  });

  test("the chrome-free artifact viewport links back to the editor", async ({
    page,
  }) => {
    const id = await createArtifact(page);
    await page.goto(`/atrium/${id}/view`);

    await expect(page.getByTestId("artifact-viewport")).toBeVisible({
      timeout: 60_000,
    });
    const back = page.getByTestId("artifact-viewport-back");
    await expect(back).toBeVisible();

    await page.screenshot({
      path: ".verification/1793-viewport-back.png",
      fullPage: false,
    });

    await back.click();
    await page.waitForURL(`**/atrium/${id}/edit`);
    expect(page.url().endsWith(`/atrium/${id}/edit`)).toBe(true);
  });
});
