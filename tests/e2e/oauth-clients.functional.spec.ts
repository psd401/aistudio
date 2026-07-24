import { test, expect } from "./fixtures"
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth"

test.describe("OAuth client application profiles (#1289)", () => {
  test("GET /admin/oauth-clients unauthenticated redirects to sign-in", async ({
    request,
  }) => {
    const response = await request.get("/admin/oauth-clients", {
      maxRedirects: 0,
    })
    expect(response.status()).toBe(307)
    expect(response.headers().location).toContain("/api/auth/signin")
  })

  test.describe("authenticated administration", () => {
    test.skip(
      process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
      "Requires the authenticated local E2E harness",
    )

    test("registration UI exposes application types and public OIDC scopes", async ({
      page,
    }) => {
      await authenticateContext(
        page.context(),
        SEEDED_ADMIN_EMAIL,
        SEEDED_ADMIN_SUB
      )
      await page.goto("/admin/oauth-clients")
      await page.getByRole("button", { name: "Register Client" }).click()

      await page.locator("#applicationType").click()
      await expect(
        page.getByRole("option", { name: "Web application" })
      ).toBeVisible()
      await expect(
        page.getByRole("option", { name: "Browser extension" })
      ).toBeVisible()
      await expect(
        page.getByRole("option", { name: "Native application" })
      ).toBeVisible()
      await page.getByRole("option", { name: "Native application" }).click()

      await expect(page.locator("#authMethod")).toBeDisabled()
      await expect(
        page.getByText(
          "Browser-extension and native apps cannot keep a secret; S256 PKCE is mandatory."
        )
      ).toBeVisible()
      await expect(page.locator("#redirectUri")).toHaveAttribute(
        "placeholder",
        /com\.example\.app:/
      )
      for (const scope of ["openid", "profile", "offline_access"]) {
        const scopeRow = page.getByText(scope, { exact: true }).locator("..")
        await expect(scopeRow.getByRole("checkbox")).toBeChecked()
        await expect(scopeRow.getByRole("checkbox")).toBeDisabled()
        await expect(scopeRow).toContainText("required for public clients")
      }
      await expect(
        page.getByText("email", { exact: true }).locator("..").getByRole("checkbox")
      ).toBeEnabled()
    })
  })
})
