import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): the workspace panel refreshes after a chat tool edits the open
 * ARTIFACT (#1749 addendum A).
 *
 * Before this, `ArtifactCanvas` fetched versions + head code only on mount and
 * `WorkspacePanel` loaded its payload (the source of the pinned `dataAccess`)
 * once per idOrSlug. So the chat wrote a new version, flipped the mode, said
 * "done", and the panel kept rendering the OLD version under the OLD pinned mode
 * until the user reloaded — which for a query-mode dashboard is exactly "I don't
 * see any data".
 *
 * DETERMINISTIC: the browser-side signal is dispatched directly rather than
 * waiting on a live model to decide to call a tool. What is proven here is the
 * half that only a real browser can prove — that the mounted panel and canvas
 * actually refetch on the event, with no page reload. That the TOOL emits the
 * signal is unit-covered (tests/unit/nexus-workspace-change-signal.test.tsx).
 *
 * Uses the seeded private artifact from tests/e2e/fixtures/atrium-editor-seed.sql
 * on the authed host :3100 server (see docs/guides/e2e-authenticated-testing.md).
 */

const ARTIFACT_SLUG = process.env.ATRIUM_ARTIFACT_E2E_SLUG ?? "atrium-artifact-e2e";

const defineNexusWorkspaceArtifactRefreshSuite = () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server + seeded artifact"
  );

  test("the open artifact refetches on atrium:workspace-changed without a reload", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();

      // Server actions POST to the current route with a Next-Action header; both
      // the panel loader and the canvas's version/code loads are server actions,
      // so counting them is how we observe a refetch.
      let serverActionCalls = 0;
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const headers = request.headers();
        if (headers["next-action"]) serverActionCalls += 1;
      });

      await page.goto(`/nexus?workspace=${ARTIFACT_SLUG}`);
      const panel = page.getByTestId("workspace-panel");
      await expect(panel).toBeVisible({ timeout: 60_000 });
      // The artifact canvas mounted (not the document editor).
      await expect(panel.locator(".atrium-artifact-canvas")).toBeVisible({ timeout: 60_000 });

      // Let the mount-time loads settle so the baseline is stable.
      await page.waitForTimeout(2_000);
      const baseline = serverActionCalls;
      expect(baseline).toBeGreaterThan(0);

      const urlBefore = page.url();
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("atrium:workspace-changed", { detail: { objectId: undefined } })
        );
      });

      // Panel loader + canvas version list + canvas head code all re-run.
      await expect.poll(() => serverActionCalls, { timeout: 20_000 }).toBeGreaterThan(baseline);
      // And none of it navigated: the refresh is in-place, not a reload.
      expect(page.url()).toBe(urlBefore);
      await expect(panel.locator(".atrium-artifact-canvas")).toBeVisible();
    } finally {
      await context.close();
    }
  });
};

test.describe(
  "Nexus workspace artifact refresh (#1749, authenticated)",
  defineNexusWorkspaceArtifactRefreshSuite
);
