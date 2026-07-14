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
import { eq, sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";
import {
  userCanAccessResource,
  filterAccessibleResourceIds,
  replaceResourceGrants,
  syncModelAllowedRoleGrants,
  listResourceGrants,
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

// ROLE-ONLY SYNC — syncModelAllowedRoleGrants (the legacy allowed_roles bridge,
// #1206) must replace ONLY the role grants and PRESERVE group grants, so the
// model create/update/import write paths never clobber admin-set group grants.
await replaceResourceGrants(
  RES_TYPE,
  RES_ID,
  [
    { grantKind: "role", grantValue: "staff" },
    { grantKind: "group", grantValue: ACTIVE_GROUP },
  ],
  adminId
);
await syncModelAllowedRoleGrants(Number(RES_ID), ["student", "teacher"], adminId);
await check("role-only sync swaps roles but keeps the group grant", async () => {
  const grants = await listResourceGrants(RES_TYPE, RES_ID);
  const roles = grants.filter((g) => g.grantKind === "role").map((g) => g.grantValue).sort();
  const groups = grants.filter((g) => g.grantKind === "group").map((g) => g.grantValue);
  assert.deepEqual(roles, ["student", "teacher"]);
  assert.deepEqual(groups, [ACTIVE_GROUP.toLowerCase()]);
});
await check("role-only sync with null clears roles, still keeps the group grant", async () => {
  await syncModelAllowedRoleGrants(Number(RES_ID), null, adminId);
  const grants = await listResourceGrants(RES_TYPE, RES_ID);
  assert.equal(grants.filter((g) => g.grantKind === "role").length, 0);
  assert.equal(grants.filter((g) => g.grantKind === "group").length, 1);
});

// Restore a clean slate BEFORE the backfill-equivalence assertion so the
// synthetic test grants on RES_ID (a non-existent model id) don't register as
// "extra" model grant rows the real allowed_roles can't explain.
await deleteAllResourceGrants(RES_TYPE, RES_ID);

// BACKFILL EQUIVALENCE — migration 111 copied ai_models.allowed_roles into
// resource_access_grants(kind='role'); the model-access matrix must be identical
// pre/post (issue AC#6). Assert the set of (model, role) grants derived from
// allowed_roles EXACTLY equals the backfilled 'model'/'role' grant rows — no
// missing rows, no extras. Uses the same predicate the migration's INSERT used.
await check("backfill: model role grants exactly reproduce allowed_roles", async () => {
  const rows = toPgRows(
    await executeQuery(
      (db) =>
        db.execute(sql`
          WITH expected AS (
            SELECT m.id::text AS resource_id, trim(role_name) AS role_name
              FROM ai_models m,
                   LATERAL jsonb_array_elements_text(m.allowed_roles) AS role_name
             WHERE m.allowed_roles IS NOT NULL
               AND jsonb_typeof(m.allowed_roles) = 'array'
               AND jsonb_array_length(m.allowed_roles) > 0
               AND length(trim(role_name)) > 0
          ),
          actual AS (
            SELECT resource_id, grant_value AS role_name
              FROM resource_access_grants
             WHERE resource_type = 'model' AND grant_kind = 'role'
          )
          SELECT count(*)::int AS mismatches FROM (
            (SELECT * FROM expected EXCEPT SELECT * FROM actual)
            UNION ALL
            (SELECT * FROM actual EXCEPT SELECT * FROM expected)
          ) diff
        `),
      "smoke.backfillEquivalence"
    )
  ) as { mismatches: number }[];
  assert.equal(rows[0]?.mismatches, 0, "allowed_roles <-> grant rows differ");
});

console.log(`resource-access-grants smoke: ${passed} checks passed`);
process.exit(0);
