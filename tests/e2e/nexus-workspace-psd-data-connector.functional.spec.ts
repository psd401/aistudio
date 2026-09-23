import { test, expect, type Page } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

import { validatedFs } from "@/lib/filesystem/validated-fs";

/**
 * E2E (gated): the Connect popover tells the truth about the PSD Data connector
 * while a workspace object is open (#1786, UI half of the fix).
 *
 * The bug: the model router auto-attached the PSD Data connector per MESSAGE,
 * only when that one message classified as `psd-data`. A follow-up like "add a
 * school dropdown" asked of an open live dashboard classified as `general`, so
 * the turn silently lost `list_available_tables` / `inspect_table_schema` /
 * `query_data` and the model wrote SQL against guessed column names. The
 * composer meanwhile showed "PSD Data" with the toggle OFF even on the turns
 * where the router HAD attached it, so nobody could tell what the model could
 * see.
 *
 * What this asserts, against the real page and the real server action:
 *  (a) ARTIFACT — with an editable artifact open, the PSD Data row renders as
 *      ON, says "On for this workspace", and is not switchable off.
 *  (b) DOCUMENT — with a document open, the same row is unchanged: off and
 *      switchable. Documents have no sandbox and no data bridge, so the rule
 *      must not widen to them.
 *
 * The unit tier (`lib/nexus/model-router/__tests__/router.test.ts`) pins that
 * this popover preview and the router's own attachment decision agree; this spec
 * is the proof that the agreed answer actually reaches the screen.
 *
 * PREREQUISITES (why this is gated — it is NOT run in CI):
 *  - Host dev server with PLAYWRIGHT_AUTH_ENABLED=true (`bun run test:e2e:local`
 *    sets this up; see docs/guides/e2e-authenticated-testing.md).
 *  - Seed: tests/e2e/fixtures/atrium-meridian-artifact-seed.sql — an
 *    admin-owned artifact AND an admin-owned document, so `canEdit` is true for
 *    the seeded admin on both and `kind` is the only thing that differs.
 *  - A connector row named "PSD Data" and NEXUS_ROUTER_MODE=active, which is
 *    what the local seed and settings already carry. The spec skips rather than
 *    fails when either is absent, because neither is this change's behaviour.
 */

const ARTIFACT_SLUG = process.env.ATRIUM_MERIDIAN_ARTIFACT_SLUG ?? "atrium-meridian-artifact";
const DOCUMENT_SLUG = process.env.ATRIUM_MERIDIAN_DOC_SLUG ?? "atrium-meridian-embed-doc";

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? ".verification";
validatedFs.mkdirSync(SHOT_DIR, { recursive: true });

/**
 * Put the composer in Advanced mode — the only mode that renders the Connect
 * popover — and open it. The mode is a server-side user preference, so this is
 * idempotent across the two tests in this file.
 */
async function openConnectPopover(page: Page): Promise<void> {
  const modeButton = page.getByRole("button", { name: "Nexus routing mode" });
  await expect(modeButton).toBeVisible({ timeout: 60_000 });

  const connect = page.getByTestId("nexus-mcp-control");
  if (!(await connect.isVisible().catch(() => false))) {
    await modeButton.click();
    // "Advanced" is a submenu whose leaves are the model families; picking one
    // is what switches the mode.
    await page.getByTestId("nexus-mode-advanced").hover();
    await page.getByTestId("nexus-family-anthropic").click();
  }

  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
}

/** The PSD Data row, or null when this deployment has no such connector. */
async function psdDataRow(page: Page) {
  const row = page.getByRole("switch", { name: /PSD Data connector/i });
  return (await row.count()) > 0 ? row.first() : null;
}

test.describe("#1786 Connect popover reflects the workspace-attached PSD Data connector", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Authenticated functional tier — needs a host dev server and AUTH_SECRET"
  );

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
  });

  test("editable artifact open → PSD Data reads as on for this workspace", async ({ page }) => {
    await page.goto(`/nexus?workspace=${ARTIFACT_SLUG}`);
    await openConnectPopover(page);

    const row = await psdDataRow(page);
    test.skip(row === null, "No PSD Data connector configured in this deployment");
    if (!row) return;

    // The whole point of the fix: on, explained, and not a lie the user has to
    // work around by flipping the toggle themselves.
    await expect(row).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).toContainText("On for this workspace");

    await page.screenshot({
      path: `${SHOT_DIR}/nexus-workspace-psd-data-artifact.png`,
      fullPage: false,
    });

    // Clicking it must not silently do nothing — it explains why it is locked.
    await row.click();
    await expect(page.getByText(/stays on while this workspace is open/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(row).toHaveAttribute("aria-checked", "true");
  });

  test("document open → PSD Data is unchanged: off and switchable", async ({ page }) => {
    await page.goto(`/nexus?workspace=${DOCUMENT_SLUG}`);
    await openConnectPopover(page);

    const row = await psdDataRow(page);
    test.skip(row === null, "No PSD Data connector configured in this deployment");
    if (!row) return;

    await expect(row).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
    await expect(row).not.toHaveAttribute("aria-disabled", "true");
    await expect(row).not.toContainText("On for this workspace");

    await page.screenshot({
      path: `${SHOT_DIR}/nexus-workspace-psd-data-document.png`,
      fullPage: false,
    });

    // Still the user's own switch on a document — the rule did not widen.
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  });
});
