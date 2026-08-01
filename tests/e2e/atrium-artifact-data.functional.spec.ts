import { expect, test } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from "./helpers/session-auth";

const HARNESS_PATH = "/test-user/artifact-data";

interface CreatedContentResponse {
  data?: {
    id?: unknown;
  };
}

async function createPrivateArtifact(
  page: import("@playwright/test").Page,
  title: string
): Promise<string> {
  const response = await page.request.post("/api/v1/content", {
    data: {
      kind: "artifact",
      title,
      body: "<p>Artifact data E2E probe</p>",
      bodyFormat: "html",
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as CreatedContentResponse;
  expect(typeof body.data?.id).toBe("string");
  if (typeof body.data?.id !== "string") {
    throw new TypeError("Artifact create response did not include an id");
  }
  return body.data.id;
}

async function cleanupArtifact(
  page: import("@playwright/test").Page,
  contentId: string | undefined
): Promise<void> {
  if (!contentId) return;
  try {
    await page.request.delete(`/api/v1/content/${contentId}`);
  } catch {
    // Best-effort teardown must not hide the assertion that actually failed.
  }
}

test.describe("Atrium Artifact Data Service — route guard (always-run)", () => {
  test("the local action harness is auth-gated", async ({ request }) => {
    const response = await request.get(HARNESS_PATH, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toContain("/api/auth/signin");
  });
});

test.describe("Atrium Artifact Data Service — real Server Action transport", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session, local PostgreSQL, and the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md"
  );
  test.describe.configure({ timeout: 120_000 });

  test("an authenticated viewer submits and lists a persisted record", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    const page = await context.newPage();
    let contentId: string | undefined;

    try {
      const marker = `artifact-data-${Date.now()}`;
      contentId = await createPrivateArtifact(page, marker);
      await page.goto(HARNESS_PATH);

      await page.getByTestId("artifact-data-content-id").fill(contentId);
      await page.getByTestId("artifact-data-namespace").fill("e2e_leaderboard");
      await page
        .getByTestId("artifact-data-payload")
        .fill(JSON.stringify({ marker, score: 42 }));
      await page.getByTestId("artifact-data-submit").click();

      const result = page.getByTestId("artifact-data-result");
      await expect(result).toContainText('"operation": "submit"');
      await expect(result).toContainText('"isSuccess": true');

      await page.getByTestId("artifact-data-list").click();
      await expect(result).toContainText('"operation": "list"');
      await expect(result).toContainText('"isSuccess": true');
      await expect(result).toContainText(marker);
      await expect(result).toContainText("Test User");
      await expect(result).not.toContainText(SEEDED_ADMIN_EMAIL);
    } finally {
      await cleanupArtifact(page, contentId);
      await context.close();
    }
  });

  test("a non-viewer receives the same NotFound mask without record data", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    await authenticateContext(
      ownerContext,
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB
    );
    const ownerPage = await ownerContext.newPage();
    let contentId: string | undefined;

    try {
      contentId = await createPrivateArtifact(
        ownerPage,
        `artifact-data-private-${Date.now()}`
      );

      const viewerContext = await browser.newContext();
      await authenticateContext(
        viewerContext,
        SEEDED_NO_CAPABILITY_EMAIL,
        SEEDED_NO_CAPABILITY_SUB
      );
      try {
        const viewerPage = await viewerContext.newPage();
        await viewerPage.goto(HARNESS_PATH);
        await viewerPage
          .getByTestId("artifact-data-content-id")
          .fill(contentId);
        await viewerPage
          .getByTestId("artifact-data-namespace")
          .fill("e2e_leaderboard");
        await viewerPage.getByTestId("artifact-data-list").click();

        const result = viewerPage.getByTestId("artifact-data-result");
        await expect(result).toContainText('"operation": "list"');
        await expect(result).toContainText('"isSuccess": false');
        await expect(result).toContainText("CONTENT_NOT_FOUND");
        await expect(result).not.toContainText(/forbidden|permission/i);
      } finally {
        await viewerContext.close();
      }
    } finally {
      await cleanupArtifact(ownerPage, contentId);
      await ownerContext.close();
    }
  });
});
