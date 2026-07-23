/**
 * Unit tests for listUserGroupEmailsByUserId (Epic #1202 Phase 2, #1205).
 *
 * The membership lookup that populates `principal.groups` — the match set for
 * `group`-kind Atrium visibility grants. The DB is mocked: `executeQuery` never
 * invokes the query-builder callback, so these tests exercise the guard (a
 * non-positive id must not query and must fail closed) and the row→string
 * projection. The lowercase/DISTINCT/active-only semantics live in SQL and are
 * covered by the canView JS path + the e2e, not here.
 */

const executeQueryMock = jest.fn();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...a: unknown[]) => executeQueryMock(...a),
  toPgRows: (r: unknown) => r,
}));

// The query builds against these tables; the callback is never run, so inert
// stand-ins are enough (the real column refs would only matter if executed).
jest.mock("@/lib/db/schema", () => ({
  groups: { id: {}, groupEmail: {}, isActive: {}, name: {} },
  groupMembers: { groupId: {}, memberEmail: {} },
  groupSelectionRules: {},
  groupRoleMappings: {},
  roles: {},
  users: { id: {}, email: {} },
}));

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  asc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {
    join: (..._a: unknown[]) => ({}),
  }),
}));

import { listUserGroupEmailsByUserId } from "@/lib/groups/queries";

beforeEach(() => {
  executeQueryMock.mockReset();
});

describe("listUserGroupEmailsByUserId (#1205)", () => {
  it("projects the group_email rows to a string[]", async () => {
    executeQueryMock.mockResolvedValueOnce([
      { groupEmail: "hs-staff@psd401.net" },
      { groupEmail: "all-staff@psd401.net" },
    ]);
    await expect(listUserGroupEmailsByUserId(7)).resolves.toEqual([
      "hs-staff@psd401.net",
      "all-staff@psd401.net",
    ]);
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    // The query is tagged so it is greppable in the log stream.
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.any(Function),
      "listUserGroupEmailsByUserId"
    );
  });

  it("returns [] and does NOT query for a non-positive / NaN user id (fails closed)", async () => {
    await expect(listUserGroupEmailsByUserId(0)).resolves.toEqual([]);
    await expect(listUserGroupEmailsByUserId(-3)).resolves.toEqual([]);
    await expect(listUserGroupEmailsByUserId(Number.NaN)).resolves.toEqual([]);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("returns [] when the user has no memberships", async () => {
    executeQueryMock.mockResolvedValueOnce([]);
    await expect(listUserGroupEmailsByUserId(7)).resolves.toEqual([]);
  });
});
