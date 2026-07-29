import { expect, test } from "./fixtures";

test.describe("Unified content migration admin guard", () => {
  test("redirects unauthenticated callers before rendering migration controls", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto("/admin/repositories");
    await expect(page).toHaveURL(/\/api\/auth\/signin/);
    await expect(page.getByTestId("content-migration-panel")).not.toBeVisible();
  });
});
