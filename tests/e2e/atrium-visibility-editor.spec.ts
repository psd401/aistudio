import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium Phase 3 visibility editor — the VisibilityChip flow (#1053).
 *
 * Drives the real VisibilityChip on the authoring page as the document's OWNER
 * (canEdit): change the visibility LEVEL via the picker, save, and confirm the
 * change is (a) reflected on the chip immediately and (b) persisted — a reload
 * re-fetches via getVisibilityAction and still shows the new level. This exercises
 * the Phase 3 path the unit tests cannot: VisibilityChip UI -> setVisibilityAction
 * (canView + assertCanEdit gates) -> getVisibilityAction round-trip.
 *
 * PREREQUISITES (why this is gated):
 *  - Host dev server with PLAYWRIGHT_AUTH_ENABLED=true
 *    (docs/guides/e2e-authenticated-testing.md).
 *  - Seed the object: tests/e2e/fixtures/atrium-visibility-seed.sql. It creates a
 *    private document owned by the admin (e2e-test-user), so the minted admin
 *    session is the owner and the chip renders editable.
 */

// The seeded object (tests/e2e/fixtures/atrium-visibility-seed.sql), owned by the
// admin so the default minted session can edit its visibility.
const OBJ_ID =
  process.env.ATRIUM_VIS_E2E_ID ?? "a7100000-0000-4000-8000-000000005050";
// Same seed: a document filed in the admin's PRIVATE collection.
const PRIVATE_COLLECTION_OBJ_ID = "a7100000-0000-4000-8000-000000005051";

test.describe("Atrium visibility editor — VisibilityChip (authenticated owner)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session + seeded object — see docs/guides/e2e-authenticated-testing.md"
  );

  test("owner sets the visibility level via the chip and the change persists", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context); // default admin = the object's owner
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${OBJ_ID}/edit`);

      // The chip loads the current visibility and is editable for the owner.
      // #1336 relabelled the trigger from a bare status badge to a "Share"
      // control; its aria-label is now "Share — visibility: <Level>".
      const chip = page.getByRole("button", { name: /^Share — visibility:/ });
      await expect(chip).toBeEnabled();

      // Open the editor and switch the level to Internal.
      await chip.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("combobox").click(); // the level picker
      await page.getByRole("option", { name: "Internal" }).click();
      await dialog.getByRole("button", { name: "Save" }).click();

      // The dialog closes and the chip reflects the new level immediately.
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole("button", { name: /visibility: Internal/ })
      ).toBeVisible();

      // Persisted: a reload re-fetches via getVisibilityAction and still shows it.
      await page.reload();
      await expect(
        page.getByRole("button", { name: /visibility: Internal/ })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("content in a private collection offers only Private, and says why", async ({
    browser,
  }) => {
    // The service rejects every non-private level for content filed in a
    // private collection. Before this, the dialog offered Internal anyway and
    // the save failed with a bare "Failed to update visibility".
    const context = await browser.newContext();
    await authenticateContext(context);
    try {
      const page = await context.newPage();
      await page.goto(`/atrium/${PRIVATE_COLLECTION_OBJ_ID}/edit`);

      const chip = page.getByRole("button", { name: /^Share — visibility:/ });
      await expect(chip).toBeEnabled();
      await chip.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByTestId("visibility-private-collection-note")
      ).toBeVisible();

      await dialog.getByRole("combobox").click();
      for (const name of ["Group", "Internal", "Public"]) {
        await expect(page.getByRole("option", { name })).toBeDisabled();
      }
      await expect(page.getByRole("option", { name: "Private" })).toBeEnabled();
    } finally {
      await context.close();
    }
  });
});
