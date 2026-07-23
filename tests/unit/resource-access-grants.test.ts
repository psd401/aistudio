/**
 * Resource-access grant helpers — pure unit + drift guards (Epic #1202 Phase 3, #1206).
 *
 * The SQL matrix (role/group/admin/unrestricted) is proven end-to-end against a
 * real DB in tests/smoke/resource-access-grants.smoke.ts. This suite pins the
 * pure `normalizeGrants` behavior AND guards the TS constant arrays against the
 * migration's CHECK constraints — the same drift class that bit #1205 (a
 * hand-written enum that fell out of sync with the canonical set).
 */

import fs from "fs";
import path from "path";
import {
  normalizeGrants,
  type ResourceGrant,
} from "@/lib/db/drizzle/resource-access";
import {
  RESOURCE_GRANT_TYPES,
  RESOURCE_GRANT_KINDS,
} from "@/lib/db/schema";

describe("normalizeGrants", () => {
  it("lowercases group emails and trims role names", () => {
    const input: ResourceGrant[] = [
      { grantKind: "group", grantValue: "  HS-Staff@PSD401.NET " },
      { grantKind: "role", grantValue: "  staff  " },
    ];
    expect(normalizeGrants(input)).toEqual([
      { grantKind: "group", grantValue: "hs-staff@psd401.net" },
      { grantKind: "role", grantValue: "staff" },
    ]);
  });

  it("drops blank / whitespace-only values", () => {
    const input: ResourceGrant[] = [
      { grantKind: "role", grantValue: "   " },
      { grantKind: "group", grantValue: "" },
      { grantKind: "role", grantValue: "staff" },
    ];
    expect(normalizeGrants(input)).toEqual([
      { grantKind: "role", grantValue: "staff" },
    ]);
  });

  it("de-duplicates case-insensitively within a kind, preserving first occurrence", () => {
    const input: ResourceGrant[] = [
      { grantKind: "role", grantValue: "Staff" },
      { grantKind: "role", grantValue: "staff" },
      { grantKind: "group", grantValue: "a@b.com" },
      { grantKind: "group", grantValue: "A@B.COM" },
    ];
    expect(normalizeGrants(input)).toEqual([
      { grantKind: "role", grantValue: "Staff" },
      { grantKind: "group", grantValue: "a@b.com" },
    ]);
  });

  it("keeps the same value across different kinds (kind is part of the key)", () => {
    const input: ResourceGrant[] = [
      { grantKind: "role", grantValue: "staff" },
      // A group grant that happens to share the string is a distinct grant.
      { grantKind: "group", grantValue: "staff" },
    ];
    expect(normalizeGrants(input)).toHaveLength(2);
  });

  it("returns [] for an empty input", () => {
    expect(normalizeGrants([])).toEqual([]);
  });
});

describe("TS constants match migration 111 CHECK constraints (drift guard)", () => {
  const migration = fs.readFileSync(
    path.join(
      process.cwd(),
      "infra/database/schema/111-resource-access-grants.sql"
    ),
    "utf8"
  );

  function checkValues(column: string): string[] {
    // Matches:  CHECK (<column> IN ('a', 'b', ...))
    const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i");
    const m = migration.match(re);
    if (!m) throw new Error(`no CHECK for ${column} in migration 111`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }

  it("resource_type CHECK equals RESOURCE_GRANT_TYPES", () => {
    expect(new Set(checkValues("resource_type"))).toEqual(
      new Set(RESOURCE_GRANT_TYPES)
    );
  });

  it("grant_kind CHECK equals RESOURCE_GRANT_KINDS", () => {
    expect(new Set(checkValues("grant_kind"))).toEqual(
      new Set(RESOURCE_GRANT_KINDS)
    );
  });
});
