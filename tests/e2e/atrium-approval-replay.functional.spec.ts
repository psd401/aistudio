import { test, expect } from "./fixtures";
import type { APIRequestContext, Browser } from "@playwright/test";
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from "./helpers/session-auth";

/**
 * E2E (gated): §26.4 approval-replay hardening (issue #1118) — drives the three
 * behavior changes end-to-end through the real REST surface + the /admin/atrium
 * approvals UI + the anonymous public reader:
 *
 *  1. create-as-private (item 2): an unauthorized public CREATE returns 201 with
 *     the object downgraded to PRIVATE and a durable `visibility_widen` request
 *     queued; approving it in /admin/atrium widens the object to public.
 *  2. version-pinned replay (items 1 + 5): an unauthorized publish queues the
 *     RAISE-TIME head; the queue row shows the "+ widen to public" badge; after
 *     the author edits the head, approving publishes the REVIEWED (pinned)
 *     version — the anonymous reader must show the raise-time body, never the
 *     newer unreviewed head.
 *  3. durable unpublish (item 2): an unauthorized public unpublish queues a
 *     replayable `unpublish` row (202); approving takes the page offline; a
 *     second unpublish of the now-offline destination is a no-op
 *     ({ unpublished: false }), not a doomed queued request.
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

  test("unauthorized publish pins the RAISE-TIME version; approve publishes it, not the edited head", async ({
    page,
    browser,
    request,
  }) => {
    const nonce = Date.now();
    const reviewedBody = `PINNED-REVIEWED-${nonce}`;
    const unreviewedBody = `UNREVIEWED-HEAD-${nonce}`;

    // Staff creates a private doc whose head is the to-be-reviewed body.
    const staff = await staffApi(browser);
    const createRes = await staff.post("/api/v1/content", {
      data: {
        kind: "document",
        title: `E2E pinned publish ${nonce}`,
        body: reviewedBody,
        bodyFormat: "markdown",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()).data;

    // Staff publish to public_web (bundling the widen) trips the §26.4 gate: 202.
    const publishRes = await staff.post(`/api/v1/content/${created.id}/publish`, {
      data: { destination: "public_web", visibility: { level: "public" } },
    });
    expect(publishRes.status()).toBe(202);

    // The author now edits the head — this newer body was NEVER reviewed.
    const versionRes = await staff.post(
      `/api/v1/content/${created.id}/versions`,
      { data: { body: unreviewedBody, bodyFormat: "markdown" } }
    );
    expect(versionRes.ok()).toBeTruthy();

    // Admin queue: the publish row carries the bundled-widen badge (item 5).
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    await page.goto("/admin/atrium");
    const row = page.getByRole("row").filter({ hasText: created.slug });
    await expect(row).toBeVisible();
    await expect(row.getByText("+ widen to public")).toBeVisible();
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);

    // The anonymous reader serves the PINNED (raise-time) version — the edited
    // head must not leak to the public page (item 1, the core of #1118).
    const publicRes = await request.get(`/p/${created.slug}`);
    expect(publicRes.status()).toBe(200);
    const html = await publicRes.text();
    expect(html).toContain(reviewedBody);
    expect(html).not.toContain(unreviewedBody);
  });

  test("unauthorized public unpublish queues a replayable request; offline unpublish is a no-op", async ({
    page,
    browser,
    request,
  }) => {
    const nonce = Date.now();

    // Staff owns the object (unpublish requires edit rights BEFORE the §26.4
    // gate — a non-owner gets 403, never a queued request). Getting it live
    // needs one approved publish first: staff publish → 202 → admin approves.
    const staff = await staffApi(browser);
    const createRes = await staff.post("/api/v1/content", {
      data: {
        kind: "document",
        title: `E2E durable teardown ${nonce}`,
        body: `unpublish body ${nonce}`,
        bodyFormat: "markdown",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()).data;
    const publishRes = await staff.post(`/api/v1/content/${created.id}/publish`, {
      data: { destination: "public_web", visibility: { level: "public" } },
    });
    expect(publishRes.status()).toBe(202);

    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB);
    await page.goto("/admin/atrium");
    const publishRow = page.getByRole("row").filter({ hasText: created.slug });
    await expect(publishRow).toBeVisible();
    await publishRow.getByRole("button", { name: "Approve" }).click();
    await expect(publishRow).toHaveCount(0);
    await expect
      .poll(async () => (await request.get(`/p/${created.slug}`)).status())
      .toBe(200);

    // Staff (owner, but unauthorized for public teardown) unpublishes →
    // durable 202 (item 2's new `unpublish` request kind), not a throw.
    const unpubRes = await staff.delete(
      `/api/v1/content/${created.id}/publish/public_web`
    );
    expect(unpubRes.status()).toBe(202);

    // Approve the queued unpublish in the admin UI; the page goes offline.
    await page.goto("/admin/atrium");
    const row = page.getByRole("row").filter({ hasText: created.slug });
    await expect(row).toBeVisible();
    await expect(row.getByText("Unpublish", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await request.get(`/p/${created.slug}`)).status())
      .toBe(404);

    // A second unpublish of the now-offline destination is a NO-OP (200,
    // unpublished:false) — it must NOT queue a doomed approval request.
    const noopRes = await staff.delete(
      `/api/v1/content/${created.id}/publish/public_web`
    );
    expect(noopRes.status()).toBe(200);
    expect((await noopRes.json()).data.unpublished).toBe(false);
  });
});
