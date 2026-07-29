import { test, expect } from "./fixtures";
import {
  authenticateContext,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from "./helpers/session-auth";

test.describe("Atrium collection management (authenticated)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated local DB harness"
  );

  test("owner manages a private hierarchy and receives conflict feedback", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, SEEDED_STAFF_EMAIL, SEEDED_STAFF_SUB);
    const suffix = Date.now().toString(36);
    const rootName = `E2E Private ${suffix}`;
    const childName = `E2E Child ${suffix}`;
    try {
      const page = await context.newPage();
      await page.goto("/atrium");
      await page.getByRole("button", { name: "New private collection" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Manage private collections",
      });
      await expect(dialog).toBeVisible();

      await dialog.getByLabel("Name").fill(rootName);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog.getByRole("status")).toContainText(
        "Collection created"
      );
      await expect(dialog.getByText("PSD Staff Intranet")).toHaveCount(0);

      await dialog.getByRole("button", { name: "New" }).click();
      await dialog.getByLabel("Name").fill(childName);
      await dialog.getByLabel("Parent").selectOption({ label: rootName });
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(
        dialog
          .getByRole("button")
          .filter({ hasText: `${rootName} / ${childName}` })
      ).toBeVisible();

      await dialog.getByRole("button", { name: "New" }).click();
      await dialog.getByLabel("Name").fill(rootName);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog.getByRole("alert")).toContainText("already exists");

      await dialog
        .getByRole("button")
        .filter({ hasText: rootName })
        .first()
        .click();
      await dialog
        .getByRole("button", { name: "Archive subtree" })
        .click();
      await expect(dialog.getByRole("status")).toContainText(
        "Collection archived"
      );
      await dialog
        .getByRole("button", { name: "Restore subtree" })
        .click();
      await expect(dialog.getByRole("status")).toContainText(
        "Collection restored"
      );
    } finally {
      await context.close();
    }
  });

  test("administrator creates and archives a district collection", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context);
    const name = `E2E District ${Date.now().toString(36)}`;
    try {
      const page = await context.newPage();
      await page.goto("/admin/atrium");
      await page.getByRole("tab", { name: "Collections" }).click();
      await page.getByRole("button", { name: "New" }).click();
      await page.getByLabel("Name").fill(name);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status")).toContainText("Collection created");
      await page
        .getByRole("button")
        .filter({ hasText: name })
        .first()
        .click();
      await page.getByRole("button", { name: "Archive subtree" }).click();
      await expect(page.getByRole("status")).toContainText(
        "Collection archived"
      );

      await page.goto("/atrium");
      await page
        .getByRole("button", { name: "New private collection" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Manage private collections",
      });
      const privateName = `E2E Admin Private ${Date.now().toString(36)}`;
      await dialog.getByLabel("Name").fill(privateName);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog.getByRole("status")).toContainText(
        "Collection created"
      );
      await expect(dialog.getByText(name)).toHaveCount(0);
      await expect(dialog.getByText("PSD Staff Intranet")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
