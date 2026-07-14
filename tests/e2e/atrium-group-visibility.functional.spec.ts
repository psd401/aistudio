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
});
