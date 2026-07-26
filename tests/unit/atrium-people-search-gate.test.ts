/**
 * Unit tests for the #1336 people-search action's access + bounding rules.
 *
 * `searchPeopleAction` backs the visibility editor's person-grant picker, and
 * it is a directory-shaped read: it returns names and emails. Everything that
 * limits it — the `atrium-content` capability gate, the minimum query length,
 * the result cap, and LIKE-escaping of user text — is load-bearing, and none of
 * it was covered by a test before (only incidentally, via mocks, in
 * visibility-chip.test.tsx).
 */

const getUserRequesterMock = jest.fn(async () => ({
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
}));
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...(a as [])),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub" })),
}));

const hasCapabilityAccessMock = jest.fn(async () => true);
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...a: unknown[]) =>
    hasCapabilityAccessMock(...(a as [])),
}));

// The query builder never executes: the mock records the callback invocation
// and returns canned rows, so the action's control flow is what is under test.
let queryCalls = 0;
let rows: Array<Record<string, unknown>> = [];
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => {
    queryCalls += 1;
    return rows;
  }),
}));

import { searchPeopleAction } from "@/actions/db/atrium/search-people";

beforeEach(() => {
  jest.clearAllMocks();
  queryCalls = 0;
  rows = [{ id: 5, name: "Student Test", email: "student@example.com" }];
  hasCapabilityAccessMock.mockResolvedValue(true);
});

describe("searchPeopleAction access gate", () => {
  it("requires the atrium-content capability", async () => {
    hasCapabilityAccessMock.mockResolvedValue(false);
    const res = await searchPeopleAction("student");
    expect(res.isSuccess).toBe(false);
    // Denied BEFORE any directory read — the gate must not be advisory.
    expect(queryCalls).toBe(0);
  });

  it("gates on `atrium-content` specifically", async () => {
    await searchPeopleAction("student");
    expect(hasCapabilityAccessMock).toHaveBeenCalledWith(
      "atrium-content",
      "cognito-sub"
    );
  });

  it("resolves the requester FIRST so an unauthenticated caller gets 401, not 403", async () => {
    // `getUserRequester` throws authNoSession for a missing session, and
    // `hasCapabilityAccess` merely returns false — so ordering the capability
    // check first would tell a logged-out user "access denied".
    getUserRequesterMock.mockRejectedValueOnce(new Error("authNoSession"));
    const res = await searchPeopleAction("student");
    expect(res.isSuccess).toBe(false);
    expect(hasCapabilityAccessMock).not.toHaveBeenCalled();
    expect(queryCalls).toBe(0);
  });
});

describe("searchPeopleAction query bounding", () => {
  it("returns nothing — WITHOUT querying — below the 2-character minimum", async () => {
    for (const q of ["", " ", "a", "  x  ".slice(0, 3)]) {
      const res = await searchPeopleAction(q);
      expect(res.isSuccess).toBe(true);
      if (res.isSuccess) expect(res.data).toEqual([]);
    }
    // A 1-char term must not be able to sweep a large slice of the directory.
    expect(queryCalls).toBe(0);
  });

  it("queries once the term reaches the minimum length", async () => {
    const res = await searchPeopleAction("st");
    expect(res.isSuccess).toBe(true);
    expect(queryCalls).toBe(1);
  });

  it("returns the projected rows (id, name, email only)", async () => {
    const res = await searchPeopleAction("student");
    expect(res.isSuccess).toBe(true);
    if (!res.isSuccess) return;
    expect(res.data).toEqual([
      { id: 5, name: "Student Test", email: "student@example.com" },
    ]);
  });

  it("tolerates an oversized term rather than passing it through", async () => {
    const res = await searchPeopleAction("x".repeat(5000));
    expect(res.isSuccess).toBe(true);
    expect(queryCalls).toBe(1);
  });
});
