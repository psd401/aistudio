/**
 * Atrium group-grant SQL/JS parity smoke (Bun + local DB)
 *
 * Epic #1202 Phase 2, #1205 acceptance: `listVisible` (the SQL path —
 * `buildVisibilitySql`) and `canView` (the JS twin) must AGREE for
 * group-granted objects, and membership must resolve through the REAL
 * `listUserGroupEmailsByUserId` query (including its `groups.is_active = true`
 * join filter). The jest suites pin the JS branch with mocks and the gated
 * Playwright spec proves the point-read; this smoke is the only place the
 * group branch of the SQL predicate executes against a real database.
 * `visibleCountsByCollection` consumes the SAME `buildVisibilitySql`
 * predicate, so the parity proven here covers it by construction; it is still
 * invoked once below so the group IN-list also executes inside the GROUP BY
 * count query.
 *
 * Prereqs: local DB with migration 110 applied and
 * tests/e2e/fixtures/atrium-group-visibility-seed.sql loaded (the same seed
 * the gated e2e uses — member/outsider users, an active-group doc, and a
 * deactivated-group doc).
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run tests/smoke/atrium-group-visibility-list.smoke.ts
 */

import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import { contentObjects, users } from "@/lib/db/schema";
import { visibilityService } from "@/lib/content/visibility-service";
import { listUserGroupEmailsByUserId } from "@/lib/groups/queries";
import type { Requester } from "@/lib/content/types";

const ACTIVE_SLUG = "group-directory-playbook";
const RETIRED_SLUG = "retired-group-playbook";
const ACTIVE_GROUP = "hs-staff-group@example.com";

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function loadUserId(cognitoSub: string): Promise<number> {
  const rows = toPgRows(
    await executeQuery(
      (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.cognitoSub, cognitoSub))
          .limit(1),
      "smoke.loadUser"
    )
  ) as { id: number }[];
  assert.ok(rows[0], `seed missing: no user ${cognitoSub} (apply the seed first)`);
  return rows[0].id;
}

const docs = toPgRows(
  await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          slug: contentObjects.slug,
          ownerUserId: contentObjects.ownerUserId,
          visibilityLevel: contentObjects.visibilityLevel,
        })
        .from(contentObjects)
        .where(inArray(contentObjects.slug, [ACTIVE_SLUG, RETIRED_SLUG])),
    "smoke.loadDocs"
  )
) as {
  id: string;
  slug: string;
  ownerUserId: number;
  visibilityLevel: "private" | "group" | "internal" | "public";
}[];
const activeDoc = docs.find((d) => d.slug === ACTIVE_SLUG);
const retiredDoc = docs.find((d) => d.slug === RETIRED_SLUG);
assert.ok(activeDoc && retiredDoc, "seed missing: apply atrium-group-visibility-seed.sql first");
// The seed always sets an owner; canView's ViewableObject requires it non-null.
assert.ok(activeDoc.ownerUserId != null && retiredDoc.ownerUserId != null);

const memberId = await loadUserId("e2e-group-member");
const outsiderId = await loadUserId("e2e-group-outsider");

function requester(userId: number, groups: string[]): Requester {
  return {
    kind: "user",
    userId,
    roles: ["staff"],
    building: null,
    department: null,
    gradeLevels: null,
    isAdmin: false,
    groups,
  };
}

// 1. REAL membership resolution — the is_active filter is the revocation
//    mechanism for deactivated groups, exercised here at the SQL layer.
const memberGroups = await listUserGroupEmailsByUserId(memberId);
const outsiderGroups = await listUserGroupEmailsByUserId(outsiderId);
await check("member resolves ONLY the active group (is_active filter)", async () => {
  assert.deepEqual(memberGroups, [ACTIVE_GROUP]);
});
await check("outsider resolves no groups", async () => {
  assert.deepEqual(outsiderGroups, []);
});

const member = requester(memberId, memberGroups);
const outsider = requester(outsiderId, outsiderGroups);

// 2. SQL list path (buildVisibilitySql) vs 3. JS point path (canView) — parity.
for (const [label, req] of [
  ["member", member],
  ["outsider", outsider],
] as const) {
  const listed = await visibilityService.listVisible(req, { kind: "document" });
  const listedSlugs = new Set(listed.map((o) => o.slug));
  for (const doc of [activeDoc, retiredDoc]) {
    const js = await visibilityService.canView(req, doc);
    const sqlSees = listedSlugs.has(doc.slug);
    await check(`${label} / ${doc.slug}: listVisible (${sqlSees}) agrees with canView (${js})`, async () => {
      assert.equal(sqlSees, js);
    });
  }
  const expectVisible = label === "member" ? [ACTIVE_SLUG] : [];
  await check(`${label} sees exactly ${JSON.stringify(expectVisible)}`, async () => {
    assert.deepEqual(
      [ACTIVE_SLUG, RETIRED_SLUG].filter((s) => listedSlugs.has(s)),
      expectVisible
    );
  });
}

// 4. visibleCountsByCollection consumes the same predicate — execute it with a
//    group-bearing principal so the group IN-list also runs inside the GROUP BY
//    count query (the seeded docs are collection-less, so no count assertion).
await check("visibleCountsByCollection executes with a group principal", async () => {
  const counts = await visibilityService.visibleCountsByCollection(member);
  assert.ok(counts instanceof Map);
});

console.log(`atrium-group-visibility-list smoke: ${passed} checks passed`);
process.exit(0);
