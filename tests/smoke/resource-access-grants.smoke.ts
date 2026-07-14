/**
 * Resource-access grants SQL smoke (Bun + local DB) — Epic #1202 Phase 3, #1206.
 *
 * `userCanAccessResource` and `filterAccessibleResourceIds` are pure-SQL gates
 * (no JS branch to unit-test with mocks), so the ONLY faithful proof of the
 * role/group/admin/unrestricted matrix is against a real database. This smoke
 * exercises every acceptance scenario the issue enumerates:
 *   role-only · group-only · both · none (unrestricted) · admin bypass
 * plus the batch filter's agreement with the single-resource check.
 *
 * It writes+clears grants on a synthetic resource id (990001) that cannot
 * collide with any real model/assistant/skill, via the same
 * replaceResourceGrants / deleteAllResourceGrants writers the admin actions use,
 * and restores a clean slate at the end (idempotent, re-runnable).
 *
 * Prereqs: local DB with migration 111 applied AND
 * tests/e2e/fixtures/atrium-group-visibility-seed.sql loaded (member/outsider
 * users + the active hs-staff-group). The e2e admin/student users
 * (e2e-test-user, e2e-student-user) come from the standard local seed.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run tests/smoke/resource-access-grants.smoke.ts
 */

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";
import {
  userCanAccessResource,
  filterAccessibleResourceIds,
  replaceResourceGrants,
  deleteAllResourceGrants,
} from "@/lib/db/drizzle/resource-access";

const RES_TYPE = "model" as const;
const RES_ID = "990001"; // synthetic — cannot collide with a real model id
const UNRESTRICTED_ID = "990002"; // never granted — always accessible
const ACTIVE_GROUP = "hs-staff-group@example.com";

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
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
  assert.ok(rows[0], `seed missing: no user ${cognitoSub} (apply the seeds first)`);
  return rows[0].id;
}

const memberId = await loadUserId("e2e-group-member"); // staff + in active group
const outsiderId = await loadUserId("e2e-group-outsider"); // staff, NOT in group
const studentId = await loadUserId("e2e-student-user"); // student role only
const adminId = await loadUserId("e2e-test-user"); // administrator

async function access(userId: number): Promise<boolean> {
  return userCanAccessResource(userId, RES_TYPE, RES_ID);
}

// Scenario NONE — no grants at all → unrestricted → everyone passes.
await deleteAllResourceGrants(RES_TYPE, RES_ID);
await check("none/unrestricted: member can access", async () =>
  assert.equal(await access(memberId), true)
);
await check("none/unrestricted: outsider can access", async () =>
  assert.equal(await access(outsiderId), true)
);
await check("none/unrestricted: student can access", async () =>
  assert.equal(await access(studentId), true)
);

// Scenario ROLE-ONLY — grant role 'staff'. staff users pass; student does not;
// admin always passes.
await replaceResourceGrants(
  RES_TYPE,
  RES_ID,
  [{ grantKind: "role", grantValue: "staff" }],
  adminId
);
await check("role-only(staff): member (staff) allowed", async () =>
  assert.equal(await access(memberId), true)
);
await check("role-only(staff): outsider (staff) allowed", async () =>
  assert.equal(await access(outsiderId), true)
);
await check("role-only(staff): student DENIED", async () =>
  assert.equal(await access(studentId), false)
);
await check("role-only(staff): admin bypass allowed", async () =>
  assert.equal(await access(adminId), true)
);

// Scenario GROUP-ONLY — grant the active group. Only the member (in the group)
// passes; the outsider (same staff role, not in group) is denied.
await replaceResourceGrants(
  RES_TYPE,
  RES_ID,
  [{ grantKind: "group", grantValue: ACTIVE_GROUP.toUpperCase() }], // upper → normalizeGrants lowercases
  adminId
);
await check("group-only: member (in group) allowed", async () =>
  assert.equal(await access(memberId), true)
);
await check("group-only: outsider (not in group) DENIED", async () =>
  assert.equal(await access(outsiderId), false)
);
await check("group-only: student DENIED", async () =>
  assert.equal(await access(studentId), false)
);
await check("group-only: admin bypass allowed", async () =>
  assert.equal(await access(adminId), true)
);

// Scenario BOTH — role 'student' UNION group. Student passes by role; member
// passes by group; outsider (staff, not in group) matches neither → denied.
await replaceResourceGrants(
  RES_TYPE,
  RES_ID,
  [
    { grantKind: "role", grantValue: "student" },
    { grantKind: "group", grantValue: ACTIVE_GROUP },
  ],
  adminId
);
await check("both: member allowed via group", async () =>
  assert.equal(await access(memberId), true)
);
await check("both: student allowed via role", async () =>
  assert.equal(await access(studentId), true)
);
await check("both: outsider (neither) DENIED", async () =>
  assert.equal(await access(outsiderId), false)
);

// Scenario ADMIN BYPASS — grant a role that matches nobody. Only the admin passes.
await replaceResourceGrants(
  RES_TYPE,
  RES_ID,
  [{ grantKind: "role", grantValue: "no-such-role" }],
  adminId
);
await check("admin-bypass: member DENIED (no matching grant)", async () =>
  assert.equal(await access(memberId), false)
);
await check("admin-bypass: admin still allowed", async () =>
  assert.equal(await access(adminId), true)
);

// BATCH — filterAccessibleResourceIds agrees with the single check. RES_ID is
// restricted (role no-such-role); UNRESTRICTED_ID has no grants.
await check("batch: outsider sees only the unrestricted id", async () => {
  const accessible = await filterAccessibleResourceIds(outsiderId, RES_TYPE, [
    RES_ID,
    UNRESTRICTED_ID,
  ]);
  assert.equal(accessible.has(UNRESTRICTED_ID), true);
  assert.equal(accessible.has(RES_ID), false);
});
await check("batch: admin sees both (admin bypass)", async () => {
  const accessible = await filterAccessibleResourceIds(adminId, RES_TYPE, [
    RES_ID,
    UNRESTRICTED_ID,
  ]);
  assert.equal(accessible.has(RES_ID), true);
  assert.equal(accessible.has(UNRESTRICTED_ID), true);
});

// Restore a clean slate.
await deleteAllResourceGrants(RES_TYPE, RES_ID);

console.log(`resource-access-grants smoke: ${passed} checks passed`);
process.exit(0);
