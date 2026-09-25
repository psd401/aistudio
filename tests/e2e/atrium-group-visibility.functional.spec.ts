import { test, expect } from "./fixtures";
import { authenticateContext } from "./helpers/session-auth";

/**
 * E2E (gated): Atrium group-directory visibility (Epic #1202 Phase 2, #1205).
 *
 * Asserts the acceptance criterion of the `group` grant kind: a document shared
 * directly to a synced Google group
 *   (a) renders (200) for a MEMBER of that group — admitted ONLY by the group
 *       grant (same role as the outsider, no building/dept/grade grant), so this
 *       proves the group-membership → principal.groups → canView path end-to-end
 *       through the session requester on the reader page, and
 *   (b) 404s for a NON-member (existence-masking — a non-viewable doc must NOT
 *       403, or its slug could be enumerated).
 *
 * Both point-read (the /c/[slug] reader) and the SQL list path share the same
 * `buildVisibilitySql` / `canView` predicate, so this reader assertion also covers
 * the list/retrieval agreement the unit + retrieval tests exercise directly.
 *
 * PREREQUISITES (this is why the suite is gated):
 *  - Run against the host dev server with PLAYWRIGHT_AUTH_ENABLED=true
 *    (see docs/guides/e2e-authenticated-testing.md).
 *  - Apply migration 110 (grant_kind += 'group') to the target DB, then seed with
 *    tests/e2e/fixtures/atrium-group-visibility-seed.sql (psql -f …). It creates the
 *    synced group + one member, the group-shared published doc, and the member /
 *    non-member users.
 *  - Optionally override the slug + users via env:
 *      ATRIUM_GROUP_SLUG, ATRIUM_GROUP_MEMBER_EMAIL, ATRIUM_GROUP_MEMBER_SUB,
 *      ATRIUM_GROUP_OUTSIDER_EMAIL, ATRIUM_GROUP_OUTSIDER_SUB
 *    (the seed file documents the defaults below).
 */

const SLUG = process.env.ATRIUM_GROUP_SLUG ?? "group-directory-playbook";
const RETIRED_SLUG =
  process.env.ATRIUM_RETIRED_GROUP_SLUG ?? "retired-group-playbook";
const MEMBER_EMAIL =
  process.env.ATRIUM_GROUP_MEMBER_EMAIL ?? "group-member@example.com";
const MEMBER_SUB = process.env.ATRIUM_GROUP_MEMBER_SUB ?? "e2e-group-member";
const OUTSIDER_EMAIL =
  process.env.ATRIUM_GROUP_OUTSIDER_EMAIL ?? "group-outsider@example.com";
const OUTSIDER_SUB =
  process.env.ATRIUM_GROUP_OUTSIDER_SUB ?? "e2e-group-outsider";

test.describe("Atrium group-directory visibility — reader (#1205)", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session + seeded group-shared doc (migration 110 + atrium-group-visibility-seed.sql)"
  );

  test("renders (200) for a MEMBER of the granted Google group", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, MEMBER_EMAIL, MEMBER_SUB);
    try {
      const res = await context.request.get(`/c/${SLUG}`);
      // The member is admitted ONLY by the group grant (their synced membership
      // flows into principal.groups on the session requester).
      expect(res.status()).toBe(200);
    } finally {
      await context.close();
    }
  });

  test("404s for a NON-member (existence-masking, not 403)", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, OUTSIDER_EMAIL, OUTSIDER_SUB);
    try {
      const res = await context.request.get(`/c/${SLUG}`);
      // A non-viewable published doc must 404, NOT 403: a 403 confirms the slug
      // exists, letting an out-of-audience user enumerate document slugs.
      expect(res.status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  test("404s for a member of a DEACTIVATED group (is_active revokes the grant)", async ({
    browser,
  }) => {
    // The member IS in retired-group@example.com per group_members, and the doc
    // carries a live grant to that email — but the group row is is_active=false,
    // so listUserGroupEmailsByUserId must exclude it from principal.groups. This
    // is the revocation path for a de-selected/deleted directory group: the
    // stale grant row remains, and the is_active join filter alone denies access.
    const context = await browser.newContext();
    await authenticateContext(context, MEMBER_EMAIL, MEMBER_SUB);
    try {
      const res = await context.request.get(`/c/${RETIRED_SLUG}`);
      expect(res.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});

/**
 * Grant passage: a doc shared with a group, filed in a district collection whose
 * own view grants admit neither user (seed section 9). Sharing must reach the
 * member — the doc opens and its section appears, listing ONLY the shared doc —
 * while the collection's other contents and the outsider stay locked out.
 */
const PASSAGE_SECTION = "e2e-restricted-budget-section";
const PASSAGE_SHARED = "e2e-restricted-shared-budget";
const PASSAGE_SIBLING = "e2e-restricted-internal-note";

test.describe("Atrium grant passage — items shared into a restricted collection", () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== "true",
    "Requires an authenticated session + atrium-group-visibility-seed.sql (section 9)"
  );

  test("member opens the shared doc; its internal sibling stays 404", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, MEMBER_EMAIL, MEMBER_SUB);
    try {
      expect((await context.request.get(`/c/${PASSAGE_SHARED}`)).status()).toBe(200);
      expect((await context.request.get(`/c/${PASSAGE_SIBLING}`)).status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  test("member sees the section, listing only the shared doc", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, MEMBER_EMAIL, MEMBER_SUB);
    const page = await context.newPage();
    try {
      const res = await page.goto(`/atrium/s/${PASSAGE_SECTION}`);
      expect(res?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { name: "Restricted Budget Section" }).first()
      ).toBeVisible();
      await expect(page.getByText("Restricted Shared Budget").first()).toBeVisible();
      await expect(page.getByText("Restricted Internal Note")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("outsider gets 404 for both the section and the shared doc", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await authenticateContext(context, OUTSIDER_EMAIL, OUTSIDER_SUB);
    try {
      expect((await context.request.get(`/c/${PASSAGE_SHARED}`)).status()).toBe(404);
      expect(
        (await context.request.get(`/atrium/s/${PASSAGE_SECTION}`)).status()
      ).toBe(404);
    } finally {
      await context.close();
    }
  });
});
