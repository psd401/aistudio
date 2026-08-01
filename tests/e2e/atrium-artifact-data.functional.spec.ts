import { expect, test } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_NO_CAPABILITY_EMAIL,
  SEEDED_NO_CAPABILITY_SUB,
} from "./helpers/session-auth";

const HARNESS_PATH = "/test-user/artifact-data";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CreatedContentResponse {
  data?: {
    id?: unknown;
  };
}

interface ListedContentResponse {
  data?: unknown;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

async function createPrivateArtifact(
  page: import("@playwright/test").Page,
  title: string,
  onCreated: (contentId: string) => void
): Promise<string> {
  const response = await page.request.post("/api/v1/content", {
    data: {
      kind: "artifact",
      title,
      body: "<p>Artifact data E2E probe</p>",
      bodyFormat: "html",
    },
  });
  const body = (await response.json()) as CreatedContentResponse;
  if (isUuid(body.data?.id)) {
    // Teardown owns the ID before either response assertion can throw.
    onCreated(body.data.id);
  }
  expect(response.status()).toBe(201);
  expect(isUuid(body.data?.id)).toBe(true);
  if (!isUuid(body.data?.id)) {
    throw new TypeError("Artifact create response did not include a UUID id");
  }
  return body.data.id;
}

function isListedContentItem(
  value: unknown
): value is { id: string; title: string } {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.title === "string";
}

async function findArtifactIdsByTitle(
  page: import("@playwright/test").Page,
  title: string
): Promise<string[] | undefined> {
  const response = await page.request.get(
    "/api/v1/content?kind=artifact&query=" + encodeURIComponent(title)
  );
  expect
    .soft(
      response.ok(),
      "Artifact fallback lookup returned HTTP " + response.status()
    )
    .toBe(true);
  if (!response.ok()) return undefined;

  const body = (await response.json()) as ListedContentResponse;
  if (!Array.isArray(body.data)) return undefined;
  return body.data
    .filter(
      (item): item is { id: string; title: string } =>
        isListedContentItem(item) && item.title === title
    )
    .map((item) => item.id);
}

async function cleanupArtifact(
  page: import("@playwright/test").Page | undefined,
  contentId: string | undefined,
  title: string
): Promise<void> {
  if (!page) return;
  try {
    // The exact-title lookup is authoritative: a malformed create response
    // must never make teardown delete an unrelated object by returned ID.
    const cleanupIds = await findArtifactIdsByTitle(page, title);
    if (!cleanupIds) return;
    expect
      .soft(
        cleanupIds.length,
        "Artifact cleanup requires one unambiguous exact-title fixture"
      )
      .toBe(1);
    if (cleanupIds.length !== 1) return;
    const [cleanupId] = cleanupIds;
    expect
      .soft(isUuid(cleanupId), "Exact-title fixture did not have a UUID id")
      .toBe(true);
    if (!isUuid(cleanupId)) return;
    if (contentId && contentId !== cleanupId) {
      expect
        .soft(
          contentId,
          "Create response ID did not match the exact-title fixture"
        )
        .toBe(cleanupId);
      return;
    }
    const response = await page.request.delete("/api/v1/content/" + cleanupId);
    expect
      .soft(
        response.ok(),
        "Artifact cleanup returned HTTP " +
          response.status() +
          " for " +
          cleanupId
      )
      .toBe(true);
  } catch (error) {
    // A soft assertion reports teardown failures without replacing the primary
    // failure that sent the test into finally.
    expect
      .soft(error, "Artifact cleanup request threw for " + (contentId ?? title))
      .toBeUndefined();
  }
}

async function restoreOwnerSessionForCleanup(
  context: import("@playwright/test").BrowserContext,
  contentId: string | undefined
): Promise<void> {
  if (!contentId) return;
  try {
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
  } catch (error) {
    expect
      .soft(error, `Could not restore owner session for cleanup of ${contentId}`)
      .toBeUndefined();
  }
}

async function closeContextSoftly(
  context: import("@playwright/test").BrowserContext,
  label: string
): Promise<void> {
  try {
    await context.close();
  } catch (error) {
    expect.soft(error, `Could not close ${label} browser context`).toBeUndefined();
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
    let page: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;
    const marker = `E2E artifact-data-${Date.now()}`;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      contentId = await createPrivateArtifact(page, marker, (createdId) => {
        contentId = createdId;
      });
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
      await cleanupArtifact(page, contentId, marker);
      await closeContextSoftly(context, "happy-path artifact-data");
    }
  });

  test("cleared sessions cannot submit or list through the Server Action transport", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    let page: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;
    const marker = `E2E artifact-data-unauthenticated-${Date.now()}`;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      contentId = await createPrivateArtifact(page, marker, (createdId) => {
        contentId = createdId;
      });
      await page.goto(HARNESS_PATH);
      // The protected layout initializes NextAuth after navigation. Let that
      // response settle before clearing cookies; otherwise an already-in-flight
      // session response can repopulate the jar after clearCookies() returns.
      await page.waitForLoadState("networkidle");

      await page.getByTestId("artifact-data-content-id").fill(contentId);
      await page.getByTestId("artifact-data-namespace").fill("e2e_auth_probe");
      await page
        .getByTestId("artifact-data-payload")
        .fill(JSON.stringify({ marker, score: 7 }));

      // Keep the already-loaded action references, but remove the identity used
      // by the subsequent Server Action POSTs. The local-only middleware probe
      // permits these exact POSTs through so the actions' own auth checks run.
      await context.clearCookies();

      const authCookies = (await context.cookies()).filter((cookie) =>
        cookie.name.includes("authjs.session-token")
      );
      expect(authCookies).toEqual([]);

      const result = page.getByTestId("artifact-data-result");
      const submitRequestPromise = page.waitForRequest(
        (request) => request.headers()["next-action"] !== undefined
      );
      await page.getByTestId("artifact-data-submit").click();
      const submitRequest = await submitRequestPromise;
      expect((await submitRequest.allHeaders()).cookie ?? "").not.toContain(
        "authjs.session-token"
      );
      await expect(result).toContainText('"operation": "submit"');
      await expect(result).toContainText('"isSuccess": false');
      await expect(result).toContainText("AUTH_NO_SESSION");

      await page.getByTestId("artifact-data-list").click();
      await expect(result).toContainText('"operation": "list"');
      await expect(result).toContainText('"isSuccess": false');
      await expect(result).toContainText("AUTH_NO_SESSION");

      // Restore the owner session only to verify that the rejected submit did
      // not persist anything. This also gives teardown an authenticated API.
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      await page.getByTestId("artifact-data-list").click();
      await expect(result).toContainText('"operation": "list"');
      await expect(result).toContainText('"isSuccess": true');
      await expect(result).not.toContainText(marker);
    } finally {
      await restoreOwnerSessionForCleanup(context, contentId);
      await cleanupArtifact(page, contentId, marker);
      await closeContextSoftly(context, "cleared-session artifact-data");
    }
  });

  test("a non-viewer receives the same NotFound mask without record data", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    let ownerPage: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;
    const title = `E2E artifact-data-private-${Date.now()}`;

    try {
      await authenticateContext(
        ownerContext,
        SEEDED_ADMIN_EMAIL,
        SEEDED_ADMIN_SUB
      );
      ownerPage = await ownerContext.newPage();
      contentId = await createPrivateArtifact(ownerPage, title, (createdId) => {
        contentId = createdId;
      });

      const viewerContext = await browser.newContext();
      try {
        await authenticateContext(
          viewerContext,
          SEEDED_NO_CAPABILITY_EMAIL,
          SEEDED_NO_CAPABILITY_SUB
        );
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
        await closeContextSoftly(viewerContext, "non-viewer artifact-data");
      }
    } finally {
      await cleanupArtifact(ownerPage, contentId, title);
      await closeContextSoftly(ownerContext, "owner artifact-data");
    }
  });
});
