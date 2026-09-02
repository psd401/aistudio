/**
 * Atrium artifact data-access mode (#1705) — end-to-end over the real REST
 * surface and the real editor UI.
 *
 * Covers the acceptance criteria that only a running app can prove:
 *  - a new artifact defaults to `records`, so nothing that existed before
 *    migration 179 changes behaviour;
 *  - an owner can move it to `query` and back through `PATCH /api/v1/content`;
 *  - the mode is rendered as an artifact-only control in Content settings, and
 *    is absent for a document (which has no sandbox at all);
 *  - an unknown mode is rejected at the schema boundary.
 *
 * The viewer-scoped query itself is NOT exercised here: it requires a deployed
 * PSD Data MCP and a live Cognito ID token, neither of which exists in the local
 * harness. That path is covered by the action unit tests
 * (`tests/unit/atrium-artifact-query-action.test.ts`).
 *
 * The #1712 loaded-mode pin is likewise NOT exercised here. Driving it end to end
 * means posting a bridge request from the sandbox frame, and the local harness has
 * no `ATRIUM_SANDBOX_ORIGIN`, so the reader renders the fail-closed notice instead
 * of a frame (see `atrium-artifact.guard.spec.ts`). It is covered by
 * `tests/unit/atrium-artifact-data-bridge.test.tsx` ("loaded-mode pin", both
 * directions plus `none`) and by the reader-page prop assertions in
 * `tests/unit/atrium-reader-page-masking.test.tsx`. What this spec does cover is
 * the precondition the pin exists for: the mode is freely reversible at any time
 * (the switch-to-query-and-back test below).
 */

import { expect, test } from "./fixtures";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ContentResponse {
  data?: {
    id?: unknown;
    kind?: unknown;
    title?: unknown;
    dataAccess?: unknown;
    version?: { bodyInline?: unknown } | null;
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function fixtureBody(title: string): string {
  return `<p>Artifact data-access E2E probe for ${title}</p>`;
}

async function createContent(
  page: import("@playwright/test").Page,
  kind: "artifact" | "document",
  title: string,
  onCreated: (contentId: string) => void
): Promise<string> {
  const response = await page.request.post("/api/v1/content", {
    data:
      kind === "artifact"
        ? { kind, title, body: fixtureBody(title), bodyFormat: "html" }
        : { kind, title, body: `Probe for ${title}`, bodyFormat: "markdown" },
  });
  const body = (await response.json()) as ContentResponse;
  if (isUuid(body.data?.id)) onCreated(body.data.id);
  expect(response.status()).toBe(201);
  if (!isUuid(body.data?.id)) {
    throw new TypeError("Create response did not include a UUID id");
  }
  return body.data.id;
}

/**
 * Delete only after proving the UUID-addressed object carries this run's unique
 * title, mirroring the record-bridge spec. An orphan keeps the recognized
 * `E2E ` prefix so `db:cleanup:e2e` can reclaim it.
 */
async function cleanupContent(
  page: import("@playwright/test").Page | undefined,
  contentId: string | undefined,
  title: string
): Promise<void> {
  if (!page || !isUuid(contentId)) return;
  try {
    const lookup = await page.request.get("/api/v1/content/" + contentId);
    if (!lookup.ok()) {
      expect.soft(lookup.ok(), "cleanup lookup HTTP " + lookup.status()).toBe(true);
      return;
    }
    const body = (await lookup.json()) as ContentResponse;
    if (body.data?.id !== contentId || body.data.title !== title) {
      expect.soft(false, "UUID-addressed content did not match the fixture").toBe(true);
      return;
    }
    const response = await page.request.delete("/api/v1/content/" + contentId);
    expect.soft(response.ok(), "cleanup HTTP " + response.status()).toBe(true);
  } catch (error) {
    expect.soft(error, "cleanup threw for " + contentId).toBeUndefined();
  }
}

test.describe("Atrium artifact data access (#1705)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session, local PostgreSQL, and the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md"
  );
  test.describe.configure({ timeout: 120_000 });

  test("an artifact defaults to records and the owner can switch it to query", async ({
    browser,
  }) => {
    const title = `E2E data-access ${crypto.randomUUID()}`;
    const context = await browser.newContext();
    let page: import("@playwright/test").Page | undefined;
    let contentId: string | undefined;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      const id = await createContent(page, "artifact", title, (v) => {
        contentId = v;
      });

      // Default — the whole point of the column's DEFAULT 'records'.
      const created = (await (
        await page.request.get("/api/v1/content/" + id)
      ).json()) as ContentResponse;
      expect(created.data?.dataAccess).toBe("records");

      // Owner switches to the viewer-scoped query mode.
      const patched = await page.request.patch("/api/v1/content/" + id, {
        data: { dataAccess: "query" },
      });
      expect(patched.ok()).toBe(true);
      expect(((await patched.json()) as ContentResponse).data?.dataAccess).toBe(
        "query"
      );

      // An unknown mode is refused at the schema boundary, not silently stored.
      const rejected = await page.request.patch("/api/v1/content/" + id, {
        data: { dataAccess: "both" },
      });
      expect(rejected.status()).toBe(400);
      const unchanged = (await (
        await page.request.get("/api/v1/content/" + id)
      ).json()) as ContentResponse;
      expect(unchanged.data?.dataAccess).toBe("query");

      // And back — the mode is not one-way.
      const restored = await page.request.patch("/api/v1/content/" + id, {
        data: { dataAccess: "records" },
      });
      expect(restored.ok()).toBe(true);
      expect(((await restored.json()) as ContentResponse).data?.dataAccess).toBe(
        "records"
      );
    } finally {
      await cleanupContent(page, contentId, title);
      await context.close();
    }
  });

  test("Content settings shows the data-access control for an artifact only", async ({
    browser,
  }) => {
    const artifactTitle = `E2E data-access ui ${crypto.randomUUID()}`;
    const documentTitle = `E2E data-access doc ${crypto.randomUUID()}`;
    const context = await browser.newContext();
    let page: import("@playwright/test").Page | undefined;
    let artifactId: string | undefined;
    let documentId: string | undefined;

    try {
      await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
      page = await context.newPage();
      const artifact = await createContent(page, "artifact", artifactTitle, (v) => {
        artifactId = v;
      });
      await createContent(page, "document", documentTitle, (v) => {
        documentId = v;
      });

      await page.goto(`/atrium/${artifact}/edit`);
      await page.getByRole("button", { name: "Content settings" }).click();
      const field = page.getByLabel("Artifact data access");
      await expect(field).toBeVisible();
      await expect(field).toHaveText(/Saved responses/);

      await field.click();
      await page.getByRole("option", { name: /Live PSD data/ }).click();
      await expect(field).toHaveText(/Live PSD data/);
      // The copy has to say the two modes are exclusive — that is the whole
      // reason the control exists rather than two independent toggles.
      await expect(
        page.getByText(/Saved responses are turned off for this artifact/)
      ).toBeVisible();
      await page.screenshot({
        path: ".verification/atrium-artifact-data-access-dialog.png",
        fullPage: true,
      });

      // A document has no sandbox, so the control must not be offered at all.
      await page.goto(`/atrium/${documentId}/edit`);
      await page.getByRole("button", { name: "Content settings" }).click();
      // exact: the document editor's heading is labelled "Document title",
      // which a substring match would also resolve (strict-mode violation).
      await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Artifact data access")).toHaveCount(0);
    } finally {
      await cleanupContent(page, artifactId, artifactTitle);
      await cleanupContent(page, documentId, documentTitle);
      await context.close();
    }
  });
});
