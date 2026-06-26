/**
 * Atrium reference visibility smoke (Bun + local DB)
 *
 * Issue #1051. Runs the REAL visibilityService.canView against the seeded
 * reference document (apply tests/e2e/fixtures/atrium-reference-seed.sql first) to
 * prove the core acceptance at the service layer with no mocks: an in-building
 * (High School) staff user may view the group/intranet doc; an out-of-building
 * staff user may not.
 *
 * Run (needs the local DB + the seed applied):
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run tests/smoke/atrium-visibility-reference.smoke.ts
 */

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentObjects } from "@/lib/db/schema";
import { visibilityService } from "@/lib/content/visibility-service";
import type { Requester } from "@/lib/content/types";

const SLUG = "board-procedure-4040";

function staffRequester(building: string): Requester {
  return {
    kind: "user",
    userId: 999000 + building.length, // arbitrary non-owner id
    roles: ["staff"],
    building,
    department: null,
    gradeLevels: null,
    isAdmin: false,
  };
}

const rows = await executeQuery(
  (db) =>
    db
      .select({
        id: contentObjects.id,
        ownerUserId: contentObjects.ownerUserId,
        visibilityLevel: contentObjects.visibilityLevel,
      })
      .from(contentObjects)
      .where(eq(contentObjects.slug, SLUG))
      .limit(1),
  "smoke.loadRefObject"
);
const obj = rows[0];
assert.ok(obj, `seed missing: no content object for slug ${SLUG} (apply the seed first)`);

const hs = await visibilityService.canView(staffRequester("High School"), obj);
assert.equal(hs, true, "High School staff should view the group/HS doc");
console.log("  ✓ in-building (High School) staff can view");

const out = await visibilityService.canView(staffRequester("Elementary"), obj);
assert.equal(out, false, "out-of-building staff should NOT view the group/HS doc");
console.log("  ✓ out-of-building staff is denied");

console.log("\natrium-visibility-reference smoke: 2 checks passed");
process.exit(0);
