import { test, expect } from "./fixtures"

function isSignInUrl(href: string): boolean {
  const pathname = new URL(href).pathname
  return pathname === "/sign-in" || pathname.startsWith("/auth/")
}

test.describe("Settings memory authentication guard", () => {
  test("an unauthenticated visitor is redirected away from /settings", async ({
    page,
  }) => {
    await page.context().clearCookies()
    await page.goto("/settings")
    await page.waitForURL((url) => isSignInUrl(url.href), {
      timeout: 15_000,
    })

    expect(isSignInUrl(page.url())).toBe(true)
  })
})
