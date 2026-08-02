import { expect, test } from "./fixtures";

test.describe("Retrieval-shadow sample admin guard", () => {
  test("redirects unauthenticated callers before rendering the sample form", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto("/admin/settings");

    await expect(page).toHaveURL(/\/api\/auth\/signin/);
    await expect(
      page.getByTestId("retrieval-shadow-sample-form"),
    ).not.toBeVisible();
  });
});
