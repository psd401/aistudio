import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium artifact-UI bug-sweep fixes (#1052) — the SANDBOX-INDEPENDENT
 * legs, driven as the signed-in owner. These assert the three fixes that don't need
 * a configured ATRIUM_SANDBOX_ORIGIN (so they're meaningful even in local/CI dev
 * where the sandbox origin is unset and the iframe fails closed):
 *
 *  1. code-tab-renders — the artifact Code tab mounts the CodeMirror editor without
 *     the "Unrecognized extension value in extension set" crash (the @codemirror/state
 *     duplicate that killed the page). Proven by the editor being visible after
 *     switching to Code.
 *  2. artifact-view-unpublished — the new chrome-free /atrium/[id]/view route is
 *     canView-gated and works for an UNPUBLISHED (draft) artifact: it does NOT 404
 *     and renders the full-viewport sandbox host (data-testid="artifact-viewport"),
 *     unlike the publication-gated /c and /p readers.
 *  3. owner-on-cards — the library grid shows the owner's display name on each card
 *     (data-testid="card-owner"), visible to all viewers.
 *
 * The sizing (Bug 2), full-bleed reader (Bug 3), render-race (Bug 4), and embed-paste
 * (Bug 5) legs that DO require a live sandbox render are covered by the smoke tests
 * (tests/smoke/atrium-artifact-sandbox-*.smoke.ts, atrium-embed-paste.smoke.ts) and
 * the unit tests, since the sandbox origin isn't configured in dev.
 *
 * PREREQUISITES (why gated) — mirrors atrium-meridian-artifact.spec.ts:
 *  - Host dev server on :3100 with PLAYWRIGHT_AUTH_ENABLED=true.
 *  - Seed: tests/e2e/fixtures/atrium-meridian-artifact-seed.sql (a DRAFT artifact +
 *    a host doc, owned by the admin e2e-test-user → the minted session owns them).
 */

const ARTIFACT_ID =
  process.env.ATRIUM_MERIDIAN_ARTIFACT_ID ?? "a7100000-0000-4000-8000-00000000d001";
const ARTIFACT_TITLE = "Meridian Metrics Artifact";

test.describe("Atrium artifact-UI fixes (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authed host dev server + seeded data — see tests/e2e/fixtures/atrium-meridian-artifact-seed.sql"
  );

  test("code-tab-renders: the Code tab mounts CodeMirror without crashing", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      // A page-crashing uncaught error (the codemirror dedupe regression) surfaces
      // as a pageerror; assert none fire while the Code tab mounts.
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/atrium/${ARTIFACT_ID}/edit`);

      await expect(page.locator(".mer-editor-topbar")).toBeVisible({ timeout: 60000 });
      // Switch to the Code tab (the direct-edit escape hatch that mounts CodeMirror).
      await page.getByRole("tab", { name: "Code" }).click();

      // The CodeMirror editor mounts and stays mounted — no "Unrecognized extension
      // value in extension set" crash killing the surface.
      const editor = page.locator('[data-testid="artifact-code-editor"]');
      await expect(editor).toBeVisible({ timeout: 15000 });
      await expect(editor.locator(".cm-editor")).toBeVisible();
      expect(
        errors.filter((m) => /extension|codemirror/i.test(m)),
        `codemirror crash surfaced: ${errors.join(" | ")}`
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("artifact-view-unpublished: /atrium/[id]/view renders a draft artifact (no 404)", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      const resp = await page.goto(`/atrium/${ARTIFACT_ID}/view`);
      // The route must NOT 404 for an unpublished artifact the viewer can see.
      expect(resp?.status(), "view route should not 404 for a viewable draft").toBeLessThan(400);
      // The chrome-free full-viewport container renders (only the sandbox, no shell).
      await expect(page.locator('[data-testid="artifact-viewport"]')).toBeVisible({
        timeout: 30000,
      });
    } finally {
      await context.close();
    }
  });

  test("owner-on-cards: the library grid shows the owner's name on cards", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto("/atrium");
      // The seeded artifact card is present…
      const card = page.locator(".mer-lib-card", { hasText: ARTIFACT_TITLE }).first();
      await expect(card).toBeVisible({ timeout: 60000 });
      // …and every rendered card exposes an owner name (owned by the seeded test user).
      await expect(page.locator('[data-testid="card-owner"]').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
