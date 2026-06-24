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
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
  stripJsonQuotes: (v: unknown) => v,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
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
});

describe("canView — unauthenticated", () => {
  it("cannot see anything non-public", async () => {
    expect(await visibilityService.canView(anonymous, obj("group"))).toBe(false);
    expect(await visibilityService.canView(anonymous, obj("private"))).toBe(false);
  });
});

describe("applyGrants — value validation", () => {
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

  it("rejects an empty grant value", async () => {
    const { tx } = fakeTx();
    await expect(
      visibilityService.applyGrants(tx, "obj-1", [{ kind: "role", value: "" }])
    ).rejects.toThrow(/required/i);
  });

  it("rejects a non-numeric 'user' grant value", async () => {
    const { tx } = fakeTx();
    await expect(
      visibilityService.applyGrants(tx, "obj-1", [
        { kind: "user", value: "not-an-id" },
      ])
    ).rejects.toThrow(/positive-integer/i);
  });

  it("rejects a non-positive 'role' grant value", async () => {
    const { tx } = fakeTx();
    await expect(
      visibilityService.applyGrants(tx, "obj-1", [{ kind: "role", value: "0" }])
    ).rejects.toThrow(/positive-integer/i);
  });

  it("rejects a grant value over 255 chars", async () => {
    const { tx } = fakeTx();
    await expect(
      visibilityService.applyGrants(tx, "obj-1", [
        { kind: "building", value: "x".repeat(256) },
      ])
    ).rejects.toThrow(/maximum length/i);
  });

  it("accepts valid numeric user/role and opaque building values", async () => {
    const { tx, inserted } = fakeTx();
    await visibilityService.applyGrants(tx, "obj-1", [
      { kind: "user", value: "42" },
      { kind: "role", value: "7" },
      { kind: "building", value: "High School" },
    ]);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as unknown[]).length).toBe(3);
  });

  it("clears grants (no insert) when given an empty set", async () => {
    const { tx, inserted } = fakeTx();
    await visibilityService.applyGrants(tx, "obj-1", []);
    expect(inserted).toHaveLength(0);
  });
});
