import { expect, test } from "./fixtures";

test.describe("Agent Connect (AI Studio) authenticated pages", () => {
  test("missing consent token requires an AI Studio session", async ({ page }) => {
    const response = await page.goto("/agent-connect-aistudio");
    expect(response).not.toBeNull();
    await expect(page).toHaveURL(/\/auth\/signin/);
  });

  test("a signed-link-shaped request cannot bypass session auth", async ({
    page,
  }) => {
    const response = await page.goto(
      "/agent-connect-aistudio?token=not-a-signed-token"
    );
    expect(response).not.toBeNull();
    await expect(page).toHaveURL(/\/auth\/signin/);
  });

  test("callback requires the same authenticated AI Studio session", async ({
    page,
  }) => {
    const response = await page.goto("/agent-connect-aistudio/callback");
    expect(response).not.toBeNull();
    await expect(page).toHaveURL(/\/auth\/signin/);
  });
});

test.describe("Agent Connect (AI Studio) API guards", () => {
  test("consent and disconnect operations reject missing invocation proof", async ({
    request,
  }) => {
    const consent = await request.post("/api/agent/consent-link", {
      data: { kind: "aistudio" },
    });
    expect(consent.status()).toBe(403);

    const disconnect = await request.post("/api/agent/aistudio", {
      data: { operation: "disconnect" },
    });
    expect(disconnect.status()).toBe(403);
  });
});
