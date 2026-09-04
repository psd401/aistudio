import { test, expect } from "./fixtures";
import type { APIRequestContext, Browser } from "@playwright/test";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

/**
 * E2E (gated): approval-replay hardening (issue #1118), re-pointed at the gates
 * that still exist after #1726 — drives them end-to-end through the real REST
 * surface, the /admin/atrium approvals UI, and the readers:
 *
 *  1. create-as-private (item 2): an unauthorized public CREATE returns 201 with
 *     the object downgraded to PRIVATE and a durable `visibility_widen` request
 *     queued; approving it in /admin/atrium widens the object to public. This is
 *     the §26.4 gate on `visibilityService.setLevel` — since #1726 the ONLY gate
 *     on who may read an object, because publishing no longer touches the
 *     audience.
 *  2. version-pinned replay (item 1): publishing out of a REVIEW-GATED
 *     collection (migration 178) queues the RAISE-TIME head; after the author
 *     edits the head, approving publishes the REVIEWED (pinned) version — the
 *     reader must show the raise-time body, never the newer unreviewed head.
 *
 * The old items 3 and 5 (a durable `unpublish` row, and the "+ widen to public"
 * badge on a publish request) covered the §26.4 gate on publishing to
 * `public_web`. #1726 removed that gate: publishing is a Live/Draft state change
 * that exposes nothing new, and `public_web` is now only an alias for the live
 * row. The remaining §26.4 publish/unpublish gate applies to the CONNECTOR
 * destinations, whose adapters still throw `not yet available` BEFORE the gate —
 * so there is no end-to-end path to drive. That gate's behaviour is covered by
 * `tests/unit/atrium-publish-service.test.ts` until a connector ships.
 *
 * Identities: seeded admin (test@example.com — approves in the UI, publishes
 * directly) and seeded staff (staff@example.com — holds `atrium-content` via the
 * staff defaultRole but NOT public-publish authority, so it always trips the
 * §26.4 gate). The reader checks use the unauthenticated `request` fixture.
 *
 * Gated: needs the host :3100 dev server + seeded users
 * (see docs/guides/e2e-authenticated-testing.md).
 */

const STAFF_EMAIL = "staff@example.com";
const STAFF_SUB = "e2e-staff-user";

/** A session-authenticated API context for the seeded staff (non-admin) user. */
async function staffApi(browser: Browser): Promise<APIRequestContext> {
  const ctx = await browser.newContext();
  await authenticateContext(ctx, STAFF_EMAIL, STAFF_SUB);
  return ctx.request;
}

test.describe("Atrium §26.4 approval replay (issue #1118)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md"
  );

  test("unauthorized public CREATE → 201 private + queued widen; approve → public", async ({
    page,
    browser,
  }) => {
    const nonce = Date.now();
    const title = `E2E widen-on-create ${nonce}`;

    // Staff (no public-publish authority) asks for a PUBLIC create.
    const staff = await staffApi(browser);
    const createRes = await staff.post("/api/v1/content", {
      data: {
        kind: "document",
        title,
        body: `widen-create body ${nonce}`,
        bodyFormat: "markdown",
        visibility: { level: "public" },
      },
    });
    // Item 2: no longer 202/blocked — created, but downgraded to private.
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()).data;
    expect(created.visibilityLevel).toBe("private");

    // The durable widen request is in the admin queue, labeled by kind.
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    await page.goto("/admin/atrium");
    const row = page.getByRole("row").filter({ hasText: created.slug });
    await expect(row).toBeVisible();
    await expect(row.getByText("Visibility widen")).toBeVisible();

    // Approve replays the widen as the admin.
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);

    // The object is now PUBLIC (visible via the API as its owner).
    const afterRes = await staff.get(`/api/v1/content/${created.id}`);
    expect(afterRes.ok()).toBeTruthy();
    expect((await afterRes.json()).data.visibilityLevel).toBe("public");
  });

  test("a review-gated collection pins the RAISE-TIME version; approve publishes it, not the edited head", async ({
    page,
    browser,
  }) => {
    const nonce = Date.now();
    const reviewedBody = `PINNED-REVIEWED-${nonce}`;
    const unreviewedBody = `UNREVIEWED-HEAD-${nonce}`;

    // An admin creates a section that requires review before anything in it goes
    // live (migration 178). Since #1726 this is the gate that puts a PUBLISH in
    // the queue — the §26.4 gate asks "is this exposure public?", which a
    // Live/Draft change never is.
    const adminCtx = await browser.newContext();
    await authenticateContext(adminCtx, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    const collectionRes = await adminCtx.request.post(
      "/api/v1/content/collections",
      {
        data: {
          name: `E2E review section ${nonce}`,
          // `district` so the staff author can file into it; a `private` section
          // belongs to its creator alone.
          scope: "district",
          defaultVisibilityLevel: "internal",
        },
      }
    );
    expect(collectionRes.status()).toBe(201);
    const collection = (await collectionRes.json()).data;
    // `requiresApproval` is UPDATE-only on the REST surface: review is switched
    // on for a section that already exists, so create does not accept it.
    const gateRes = await adminCtx.request.patch(
      `/api/v1/content/collections/${collection.id}`,
      { data: { requiresApproval: true } }
    );
    expect(gateRes.ok()).toBeTruthy();

    // Staff creates a doc IN that section whose head is the to-be-reviewed body.
    const staff = await staffApi(browser);
    const createRes = await staff.post("/api/v1/content", {
      data: {
        kind: "document",
        title: `E2E pinned publish ${nonce}`,
        body: reviewedBody,
        bodyFormat: "markdown",
        collectionId: collection.id,
        visibility: { level: "internal" },
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()).data;

    // Staff publishes: the section's review gate queues it (202) rather than
    // taking it live.
    const publishRes = await staff.post(`/api/v1/content/${created.id}/publish`, {
      data: {},
    });
    expect(publishRes.status()).toBe(202);

    // The author now edits the head — this newer body was NEVER reviewed.
    const versionRes = await staff.post(
      `/api/v1/content/${created.id}/versions`,
      { data: { body: unreviewedBody, bodyFormat: "markdown" } }
    );
    expect(versionRes.ok()).toBeTruthy();

    // Admin queue: approve the pinned publish.
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    await page.goto("/admin/atrium");
    const row = page.getByRole("row").filter({ hasText: created.slug });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);

    // The reader serves the PINNED (raise-time) version — the edited head must
    // not leak to the live page (item 1, the core of #1118).
    const readerRes = await adminCtx.request.get(`/c/${created.slug}`);
    expect(readerRes.status()).toBe(200);
    const html = await readerRes.text();
    expect(html).toContain(reviewedBody);
    expect(html).not.toContain(unreviewedBody);

    await adminCtx.close();
  });

  test("publishing is NOT gated when nothing about the exposure changes (#1726)", async ({
    browser,
    request,
  }) => {
    const nonce = Date.now();

    // The same staff identity that trips every §26.4 gate. Publishing outside a
    // review-gated section now completes immediately, because making an object
    // live changes no audience — the Level already decided it.
    const staff = await staffApi(browser);
    const createRes = await staff.post("/api/v1/content", {
      data: {
        kind: "document",
        title: `E2E ungated publish ${nonce}`,
        body: `ungated body ${nonce}`,
        bodyFormat: "markdown",
        visibility: { level: "internal" },
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()).data;

    const publishRes = await staff.post(`/api/v1/content/${created.id}/publish`, {
      data: {},
    });
    expect([200, 201]).toContain(publishRes.status());

    // Internal, so the ANONYMOUS public address must still 404 — being live is
    // half the derived public gate, and the Level is the other half.
    await expect
      .poll(async () => (await request.get(`/p/${created.slug}`)).status())
      .toBe(404);

    // Taking it back down is ungated too, and idempotent.
    const unpubRes = await staff.delete(
      `/api/v1/content/${created.id}/publish/intranet`
    );
    expect(unpubRes.status()).toBe(200);
    const noopRes = await staff.delete(
      `/api/v1/content/${created.id}/publish/intranet`
    );
    expect(noopRes.status()).toBe(200);
    expect((await noopRes.json()).data.unpublished).toBe(false);
  });
});
