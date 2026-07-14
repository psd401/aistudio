/**
 * Unit tests for Atrium canView truth table (Issue #1058, §12.2 / §31.1).
 *
 * Exercises every visibility level x grant kind x principal combination. The DB
 * layer is mocked so `grantsFor` resolves a controllable grant set; the Drizzle
 * query callback is never executed.
 */

const executeQueryMock = jest.fn();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  // listVisible references these types only; provide inert stand-ins.
  type: {},
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {},
  contentVisibilityGrants: {},
  // listVisible LEFT JOINs users to project the owner display name (#1052).
  users: { id: {}, firstName: {}, lastName: {}, email: {} },
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
  stripJsonQuotes: (v: unknown) => v,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  ne: (...a: unknown[]) => a,
  // `sql` is a tagged-template fn with a `.join` helper (used by buildVisibilitySql).
  sql: Object.assign((..._a: unknown[]) => ({}), {
    join: (..._a: unknown[]) => ({}),
  }),
}));

import { visibilityService } from "@/lib/content/visibility-service";
import type { Requester } from "@/lib/content/types";

type Grant = { kind: string; value: string };

/** Drive the next grantsFor() call with a specific grant set. */
function withGrants(grants: Grant[]): void {
  // grantsFor maps over executeQuery's resolved rows: { kind, value }.
  executeQueryMock.mockResolvedValueOnce(grants);
}

const OWNER_ID = 7;

function obj(
  visibilityLevel: "private" | "group" | "internal" | "public",
  ownerUserId = OWNER_ID
) {
  return { id: "obj-1", ownerUserId, visibilityLevel };
}

const staffUser: Requester = {
  kind: "user",
  userId: 100,
  roles: ["staff"],
  building: "High School",
  department: "Math",
  gradeLevels: ["9"],
  isAdmin: false,
};
// A user who belongs to a synced Google group (lowercased email in `groups`),
// for the `group`-kind grant tests (#1205). Distinct from `staffUser` (no groups)
// so a group grant matches ONLY the member.
const groupMemberUser: Requester = {
  ...staffUser,
  userId: 101,
  groups: ["hs-staff@psd401.net"],
};
const admin: Requester = { ...staffUser, userId: 1, isAdmin: true };
const owner: Requester = { ...staffUser, userId: OWNER_ID };
const anonymous: Requester = {
  kind: "agent-autonomous",
  agentId: "a1",
  roleId: null,
  roles: [],
  scopes: [],
  agentLabel: "anon",
};
const roledAgent: Requester = {
  kind: "agent-autonomous",
  agentId: "a2",
  roleId: 2,
  roles: ["staff"],
  scopes: ["content:create"],
  agentLabel: "bot",
};

beforeEach(() => {
  executeQueryMock.mockReset();
});

describe("canView — public", () => {
  it("is visible to everyone, including unauthenticated", async () => {
    expect(await visibilityService.canView(anonymous, obj("public"))).toBe(true);
    expect(await visibilityService.canView(staffUser, obj("public"))).toBe(true);
    // No grant lookup needed for public.
    expect(executeQueryMock).not.toHaveBeenCalled();
  });
});

describe("canView — internal", () => {
  it("is visible to any authenticated principal", async () => {
    expect(await visibilityService.canView(staffUser, obj("internal"))).toBe(true);
    expect(await visibilityService.canView(roledAgent, obj("internal"))).toBe(true);
  });
  it("is not visible to an unauthenticated principal (no user, no roles)", async () => {
    expect(await visibilityService.canView(anonymous, obj("internal"))).toBe(false);
  });
});

describe("canView — admin & owner", () => {
  // Both short-circuit at the isAdmin / ownerUserId-equality checks BEFORE any
  // grant lookup, so no withGrants() setup is needed; assert grantsFor (which
  // runs through executeQuery) is never called to make the short-circuit explicit.
  it("admin sees a private object they do not own (no grant lookup)", async () => {
    expect(await visibilityService.canView(admin, obj("private"))).toBe(true);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });
  it("owner sees their own private object (no grant lookup)", async () => {
    expect(await visibilityService.canView(owner, obj("private"))).toBe(true);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });
});

describe("canView — private", () => {
  it("hidden from a non-owner without a per-user grant", async () => {
    withGrants([]);
    expect(await visibilityService.canView(staffUser, obj("private"))).toBe(false);
  });
  it("visible to a non-owner with an explicit per-user grant", async () => {
    withGrants([{ kind: "user", value: "100" }]);
    expect(await visibilityService.canView(staffUser, obj("private"))).toBe(true);
  });
  it("a role grant does NOT widen a private object", async () => {
    withGrants([{ kind: "role", value: "staff" }]);
    expect(await visibilityService.canView(staffUser, obj("private"))).toBe(false);
  });
  it("short-circuits (no grantsFor DB call) for a userId-less principal", async () => {
    // A role-only autonomous agent has no userId, so it can never match a `user`
    // grant — `canView` must return false WITHOUT the grantsFor round-trip (both
    // for efficiency and to avoid a timing side-channel on private existence).
    expect(await visibilityService.canView(roledAgent, obj("private"))).toBe(
      false
    );
    expect(executeQueryMock).not.toHaveBeenCalled();
  });
});

describe("canView — group grants", () => {
  it("role grant matches a principal role", async () => {
    withGrants([{ kind: "role", value: "staff" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(true);
  });
  it("role grant fails when the principal lacks the role", async () => {
    withGrants([{ kind: "role", value: "administrator" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(false);
  });
  it("building grant matches the principal building", async () => {
    withGrants([{ kind: "building", value: "High School" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(true);
  });
  it("building grant fails for an out-of-building user", async () => {
    withGrants([{ kind: "building", value: "Middle School" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(false);
  });
  it("department grant matches", async () => {
    withGrants([{ kind: "department", value: "Math" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(true);
  });
  it("grade grant matches one of the principal grade levels", async () => {
    withGrants([{ kind: "grade", value: "9" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(true);
  });
  it("grade grant fails when not in the principal grade levels", async () => {
    withGrants([{ kind: "grade", value: "12" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(false);
  });
  it("user grant matches the principal user id (as text)", async () => {
    withGrants([{ kind: "user", value: "100" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(true);
  });
  it("group object with no matching grants is hidden", async () => {
    withGrants([{ kind: "building", value: "Elsewhere" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(false);
  });
  it("an autonomous role-bearing agent matches role grants", async () => {
    withGrants([{ kind: "role", value: "staff" }]);
    expect(await visibilityService.canView(roledAgent, obj("group"))).toBe(true);
  });

  it("group grant matches a member of the granted Google group (#1205)", async () => {
    withGrants([{ kind: "group", value: "hs-staff@psd401.net" }]);
    expect(await visibilityService.canView(groupMemberUser, obj("group"))).toBe(
      true
    );
  });
  it("group grant fails for a non-member (no matching membership)", async () => {
    // staffUser carries no `groups`, so a group grant matches no one but a member.
    withGrants([{ kind: "group", value: "hs-staff@psd401.net" }]);
    expect(await visibilityService.canView(staffUser, obj("group"))).toBe(false);
  });
  it("group grant fails when the member belongs to a DIFFERENT group", async () => {
    withGrants([{ kind: "group", value: "elsewhere@psd401.net" }]);
    expect(await visibilityService.canView(groupMemberUser, obj("group"))).toBe(
      false
    );
  });
  it("an autonomous agent (no human identity) never matches a group grant", async () => {
    withGrants([{ kind: "group", value: "hs-staff@psd401.net" }]);
    expect(await visibilityService.canView(roledAgent, obj("group"))).toBe(false);
  });
});

describe("canView — group grant is gated on group VISIBILITY (guard mirror #1205)", () => {
  it("a group-kind grant on a PRIVATE object grants a member nothing extra", async () => {
    // The private branch consults ONLY `user` grants — a stray `group` grant on a
    // non-group object must NOT authorize a member, mirroring buildVisibilitySql's
    // `visibility_level = 'group'` gate on the whole grant-sweep EXISTS clause.
    withGrants([{ kind: "group", value: "hs-staff@psd401.net" }]);
    expect(
      await visibilityService.canView(groupMemberUser, obj("private"))
    ).toBe(false);
  });
});

describe("canView — unauthenticated", () => {
  it("cannot see anything non-public", async () => {
    expect(await visibilityService.canView(anonymous, obj("group"))).toBe(false);
    expect(await visibilityService.canView(anonymous, obj("private"))).toBe(false);
  });
});

describe("applyGrantsForLevel — grant value validation (group level)", () => {
  // The public grant-write surface is `applyGrantsForLevel`; for `group` it routes
  // every supplied grant through the same value validation/dedup/trim logic the
  // (now-internal) applyGrantsInTx primitive runs. These cases drive that path.

  /** Minimal tx whose delete/insert builders resolve and record inserted rows. */
  function fakeTx() {
    const inserted: unknown[] = [];
    const tx = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: async (rows: unknown) => {
          inserted.push(rows);
        },
      }),
    };
    return { tx: tx as never, inserted };
  }

  const apply = (tx: never, grants: Grant[]) =>
    visibilityService.applyGrantsForLevel(
      tx,
      "obj-1",
      "group",
      grants as never
    );

  it("rejects an empty grant value", async () => {
    const { tx } = fakeTx();
    await expect(apply(tx, [{ kind: "role", value: "" }])).rejects.toThrow(
      /required/i
    );
  });

  it("rejects a non-numeric 'user' grant value", async () => {
    const { tx } = fakeTx();
    await expect(
      apply(tx, [{ kind: "user", value: "not-an-id" }])
    ).rejects.toThrow(/positive-integer/i);
  });

  it("accepts a non-numeric 'role' grant value (role grants match by NAME)", async () => {
    // A role grant carries the role NAME (e.g. "staff"), matched against
    // principal.roles in canView. It must NOT be validated as a numeric id —
    // doing so (Phase 0 behaviour) made role-based group grants unmatchable.
    const { tx, inserted } = fakeTx();
    await apply(tx, [{ kind: "role", value: "staff" }]);
    expect(inserted).toHaveLength(1);
  });

  it("rejects a grant value over 255 chars", async () => {
    const { tx } = fakeTx();
    await expect(
      apply(tx, [{ kind: "building", value: "x".repeat(256) }])
    ).rejects.toThrow(/maximum length/i);
  });

  it("accepts a numeric user id, a role NAME, and opaque building values", async () => {
    const { tx, inserted } = fakeTx();
    await apply(tx, [
      { kind: "user", value: "42" },
      { kind: "role", value: "staff" },
      { kind: "building", value: "High School" },
    ]);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as unknown[]).length).toBe(3);
  });

  it("clears grants (no insert) when narrowing to internal with an empty set", async () => {
    const { tx, inserted } = fakeTx();
    await visibilityService.applyGrantsForLevel(tx, "obj-1", "internal", []);
    expect(inserted).toHaveLength(0);
  });

  it("rejects an unknown grant kind (defense-in-depth)", async () => {
    // A cast-through/untyped caller could pass a kind outside the enum. The
    // service guard must reject it with a clean ValidationError before it
    // reaches the DB enum column.
    const { tx } = fakeTx();
    await expect(
      apply(tx, [{ kind: "superuser" as never, value: "1" }])
    ).rejects.toThrow(/invalid grant kind/i);
  });

  it("deduplicates grants on (kind, value) before insert", async () => {
    // A duplicate in the caller's input would otherwise hit the uq_cvg unique
    // constraint and roll back the tx with a confusing 23505. Dedup keeps the
    // insert clean.
    const { tx, inserted } = fakeTx();
    await apply(tx, [
      { kind: "role", value: "staff" },
      { kind: "role", value: "staff" },
      { kind: "user", value: "42" },
    ]);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as unknown[]).length).toBe(2);
  });

  it("accepts a group-email grant value and lowercases it before storing (#1205)", async () => {
    // Emails are case-insensitive; the stored value must be lowercase so it matches
    // the lowercased principal.groups. A mixed-case input is normalized on write.
    const { tx, inserted } = fakeTx();
    await apply(tx, [{ kind: "group", value: "HS-Staff@PSD401.net" }]);
    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as Array<{ grantKind: string; grantValue: string }>;
    expect(rows[0]).toMatchObject({
      grantKind: "group",
      grantValue: "hs-staff@psd401.net",
    });
  });

  it("rejects a group grant value that is not an email (defense-in-depth #1205)", async () => {
    // A group grant value must look like an email — a role name or bare id could
    // never equal a synced group email, so reject it rather than store an inert grant.
    const { tx } = fakeTx();
    await expect(
      apply(tx, [{ kind: "group", value: "not-an-email" }])
    ).rejects.toThrow(/group email/i);
  });

  it("rejects a whitespace-only grant value (trims to empty → required)", async () => {
    // "   " is a non-empty string but trims to "" — it could never equal a real
    // attribute, so it must be rejected as missing rather than stored inert.
    const { tx } = fakeTx();
    await expect(
      apply(tx, [{ kind: "building", value: "   " }])
    ).rejects.toThrow(/required/i);
  });

  it("trims surrounding whitespace from grant values before storing", async () => {
    // A padded " Math " would never equal the un-padded users.building attribute
    // it matches in canView; store the trimmed value so the grant authorizes.
    const { tx, inserted } = fakeTx();
    await apply(tx, [{ kind: "building", value: " Math " }]);
    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as Array<{ grantValue: string }>;
    expect(rows[0].grantValue).toBe("Math");
  });

  it("dedups a padded value against its trimmed twin", async () => {
    const { tx, inserted } = fakeTx();
    await apply(tx, [
      { kind: "role", value: "staff" },
      { kind: "role", value: " staff " },
    ]);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as unknown[]).length).toBe(1);
  });
});

describe("setLevelInTx — level + grant write semantics", () => {
  /**
   * A fake tx that records grant inserts AND the `update().set()` payload so we
   * can assert both the grant replacement and the level write.
   */
  function fakeTx() {
    const inserted: unknown[][] = [];
    const updates: Record<string, unknown>[] = [];
    // Record each delete's `where` argument so we can tell a full grant clear
    // (`applyGrantsInTx` → `eq(objectId)`) apart from the user-preserving clear
    // (`clearNonUserGrantsInTx` → `and(eq(objectId), ne(kind, "user"))`).
    const deletes: unknown[] = [];
    const tx = {
      delete: () => ({
        where: async (clause: unknown) => {
          deletes.push(clause);
        },
      }),
      insert: () => ({
        values: async (rows: unknown) => {
          inserted.push(rows as unknown[]);
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => undefined };
        },
      }),
    };
    return { tx: tx as never, inserted, updates, deletes };
  }

  it("rejects a group level with no grants", async () => {
    const { tx, updates } = fakeTx();
    await expect(
      visibilityService.setLevelInTx(tx, "obj-1", { level: "group", grants: [] })
    ).rejects.toThrow(/at least one grant/i);
    // The guard fires before any level write.
    expect(updates).toHaveLength(0);
  });

  it("writes a group level and inserts its grants", async () => {
    const { tx, inserted, updates } = fakeTx();
    await visibilityService.setLevelInTx(tx, "obj-1", {
      level: "group",
      grants: [{ kind: "role", value: "staff" }],
    });
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as unknown[]).length).toBe(1);
    expect(updates[0]?.visibilityLevel).toBe("group");
  });

  it("preserves user grants when narrowing to private (read paths honor them)", async () => {
    // private IS grant-keyed for per-user grants on both read paths
    // (buildVisibilitySql's privateUserGrant + canView's user-grant branch), so a
    // write to `private` must NOT delete them — it issues a single user-preserving
    // delete (drops role/building/department/grade grants only) and inserts none.
    const { tx, inserted, updates, deletes } = fakeTx();
    await visibilityService.setLevelInTx(tx, "obj-1", { level: "private" });
    expect(inserted).toHaveLength(0);
    expect(deletes).toHaveLength(1); // the user-preserving clear
    expect(deletes[0]).toBeDefined(); // a `where` clause (not a full unconditional delete)
    expect(updates[0]?.visibilityLevel).toBe("private");
  });

  it("rejects grants supplied for a non-group level (no silent drop)", async () => {
    // Grants on a non-grant-keyed level are a caller bug. Throw rather than
    // silently clearing them — silent clearing would widen access to exactly the
    // principals the caller meant to scope.
    const { tx, updates } = fakeTx();
    await expect(
      visibilityService.setLevelInTx(tx, "obj-1", {
        level: "internal",
        grants: [{ kind: "role", value: "staff" }],
      })
    ).rejects.toThrow(/only valid for group/i);
    expect(updates).toHaveLength(0);
  });

  it("writes public/internal levels with no grants", async () => {
    for (const level of ["public", "internal"] as const) {
      const { tx, inserted, updates } = fakeTx();
      await visibilityService.setLevelInTx(tx, "obj-1", { level });
      expect(inserted).toHaveLength(0);
      expect(updates[0]?.visibilityLevel).toBe(level);
    }
  });

  it("rejects an unknown visibility level (defense-in-depth)", async () => {
    // A cast-through/untyped caller (e.g. a future API route) could pass a level
    // outside the enum. The service guard must reject it before any DB write.
    const { tx, updates } = fakeTx();
    await expect(
      visibilityService.setLevelInTx(tx, "obj-1", {
        level: "restricted" as never,
      })
    ).rejects.toThrow(/invalid visibility level/i);
    expect(updates).toHaveLength(0);
  });
});

describe("applyGrantsForLevel — level-aware grant reconciliation", () => {
  function fakeTx() {
    const inserted: unknown[][] = [];
    const deletes: unknown[] = [];
    const tx = {
      delete: () => ({
        where: async (clause: unknown) => {
          deletes.push(clause);
        },
      }),
      insert: () => ({
        values: async (rows: unknown) => {
          inserted.push(rows as unknown[]);
        },
      }),
    };
    return { tx: tx as never, inserted, deletes };
  }

  it("enforces the group-≥1-grant invariant (closes the applyGrants bypass)", async () => {
    // Unlike the low-level `applyGrants`, this path runs `assertWritableLevel`, so
    // a group object can never be left grant-less and invisible.
    const { tx } = fakeTx();
    await expect(
      visibilityService.applyGrantsForLevel(tx, "obj-1", "group", [])
    ).rejects.toThrow(/at least one grant/i);
  });

  it("rejects grants supplied for a non-group level (no silent drop)", async () => {
    const { tx } = fakeTx();
    await expect(
      visibilityService.applyGrantsForLevel(tx, "obj-1", "private", [
        { kind: "user", value: "100" },
      ])
    ).rejects.toThrow(/only valid for group/i);
  });

  it("inserts the supplied grants for a valid group level", async () => {
    const { tx, inserted } = fakeTx();
    await visibilityService.applyGrantsForLevel(tx, "obj-1", "group", [
      { kind: "role", value: "staff" },
    ]);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as unknown[]).length).toBe(1);
  });
});

describe("listVisible — limit/offset clamping", () => {
  /**
   * Drive listVisible with a given filter and capture the `.limit()` / `.offset()`
   * arguments the query builder receives. The query callback is invoked against a
   * chainable spy `db`; the builder resolves to `[]` so no row mapping runs.
   */
  async function captureLimitOffset(
    filter: Record<string, unknown>
  ): Promise<{ limit: unknown; offset: unknown }> {
    let captured: { limit: unknown; offset: unknown } = {
      limit: undefined,
      offset: undefined,
    };
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "from", "leftJoin", "where", "orderBy"]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.limit = jest.fn((v: unknown) => {
      captured.limit = v;
      return builder;
    });
    builder.offset = jest.fn((v: unknown) => {
      captured.offset = v;
      // Final call in the chain — resolve to an empty result set.
      return Promise.resolve([]);
    });
    executeQueryMock.mockImplementationOnce(
      (cb: (db: unknown) => unknown) => cb(builder)
    );
    await visibilityService.listVisible(
      staffUser,
      filter as Parameters<typeof visibilityService.listVisible>[1]
    );
    return captured;
  }

  it("defaults to limit 50 / offset 0 when unset", async () => {
    const { limit, offset } = await captureLimitOffset({});
    expect(limit).toBe(50);
    expect(offset).toBe(0);
  });

  it("coerces a NaN limit/offset to the defaults (no LIMIT NaN)", async () => {
    // A query-string parse (e.g. parseInt('abc')) yields NaN, which `?? 50`
    // would NOT coalesce — it must not reach `.limit()`.
    const { limit, offset } = await captureLimitOffset({
      limit: Number.NaN,
      offset: Number.NaN,
    });
    expect(limit).toBe(50);
    expect(offset).toBe(0);
  });

  it("clamps an over-max limit to 200 and a negative offset to 0", async () => {
    const { limit, offset } = await captureLimitOffset({
      limit: 10_000,
      offset: -5,
    });
    expect(limit).toBe(200);
    expect(offset).toBe(0);
  });

  it("clamps a sub-1 limit up to 1 and honours a valid offset", async () => {
    const { limit, offset } = await captureLimitOffset({ limit: 0, offset: 25 });
    expect(limit).toBe(1);
    expect(offset).toBe(25);
  });
});
