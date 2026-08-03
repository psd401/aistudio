import { test, expect } from "./fixtures"
import { authenticateContext } from "./helpers/session-auth"
import {
  gotoNexus,
  sendMessage,
  waitForStreamingComplete,
} from "./nexus/utils"

test.describe("Nexus chat PII passthrough (authenticated)", () => {
  test.describe.configure({ timeout: 180_000 })
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires the authenticated host dev server and a configured chat model",
  )

  test("renders a named student's greeting without privacy placeholders", async ({
    page,
  }, testInfo) => {
    await authenticateContext(page.context())
    await gotoNexus(page)

    await sendMessage(
      page,
      "Write a one-sentence greeting for a student named Johnny Smith",
    )
    await waitForStreamingComplete(page, 120_000)

    const response = page.locator('[data-role="assistant"]').last()
    await expect(response).toBeVisible({ timeout: 120_000 })
    await expect(response).toContainText("Johnny", { timeout: 120_000 })
    await expect(page.getByTestId("nexus-shell")).not.toContainText("[PII:")
    await page.screenshot({
      path: testInfo.outputPath("nexus-chat-pii-passthrough.png"),
      fullPage: true,
    })
  })
})
