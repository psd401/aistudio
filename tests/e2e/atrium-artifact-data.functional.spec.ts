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

interface ContentLookupResponse {
  data?: {
    id?: unknown;
    kind?: unknown;
    title?: unknown;
    version?: {
      bodyInline?: unknown;
    } | null;
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function artifactFixtureBody(title: string): string {
  return `<p>Artifact data E2E probe for ${title}</p>`;
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
      body: artifactFixtureBody(title),
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

async function cleanupArtifact(
  page: import("@playwright/test").Page | undefined,
  contentId: string | undefined,
  title: string
): Promise<void> {
  if (!page || !contentId) return;
  try {
    expect
      .soft(isUuid(contentId), "Captured artifact fixture ID was not a UUID")
      .toBe(true);
    if (!isUuid(contentId)) return;

    // Never delete solely because create returned an ID. First prove that the
    // UUID-addressed, owner-visible object carries this test's unique title and
    // body marker. If create did not return a trustworthy UUID, the recognized
    // `E2E ` title prefix leaves the orphan recoverable by db:cleanup:e2e.
    const lookupResponse = await page.request.get(
      "/api/v1/content/" + contentId
    );
    expect
      .soft(
        lookupResponse.ok(),
        "Artifact cleanup lookup returned HTTP " + lookupResponse.status()
      )
      .toBe(true);
    if (!lookupResponse.ok()) return;

    const lookupBody = (await lookupResponse.json()) as ContentLookupResponse;
    const isExpectedFixture =
      lookupBody.data?.id === contentId &&
      lookupBody.data.kind === "artifact" &&
      lookupBody.data.title === title &&
      lookupBody.data.version?.bodyInline === artifactFixtureBody(title);
    expect
      .soft(
        isExpectedFixture,
        "UUID-addressed content did not match the artifact fixture markers"
      )
      .toBe(true);
    if (!isExpectedFixture) return;

    const response = await page.request.delete("/api/v1/content/" + contentId);
    expect
      .soft(
        response.ok(),
        "Artifact cleanup returned HTTP " +
          response.status() +
          " for " +
          contentId
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
    const marker = `E2E artifact-data-${crypto.randomUUID()}`;
    const context = await browser.newContext();
    let page: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;

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
    const marker = `E2E artifact-data-unauthenticated-${crypto.randomUUID()}`;
    const context = await browser.newContext();
    let page: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;

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
    const title = `E2E artifact-data-private-${crypto.randomUUID()}`;
    const ownerContext = await browser.newContext();
    let ownerPage: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;

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
