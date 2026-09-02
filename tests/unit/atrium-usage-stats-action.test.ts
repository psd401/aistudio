/** @jest-environment node */

/**
 * Unit tests for `getAtriumUsageStatsAction`'s gates and shaping.
 *
 *  - The administrator gate runs BEFORE any query: a non-admin caller gets a
 *    failed ActionState and the database is never touched.
 *  - The range is validated against the allowlist over the RPC boundary (the
 *    TS type is not enforced there): an unknown value — including a prototype
 *    key like "constructor" — is a validation failure, not a silent 30d.
 *  - For an admin with a valid range, the eight reads (one headline scan plus
 *    seven grouped breakdowns) are shaped into the DTO — the count the
 *    `toHaveBeenCalledTimes(8)` assertion below pins down:
 *    headline counts land on their tiles, missing breakdown rows become
 *    zeros/empties, and the daily window is zero-filled to its length.
 */

const getUserRequesterMock = jest.fn(async () => ({
  kind: "user" as const,
  userId: 1,
  roles: ["administrator"],
  isAdmin: true,
}));
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...args: unknown[]) => getUserRequesterMock(...(args as [])),
}));

const executeQueryMock = jest.fn();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  toPgRows: (rows: unknown) => rows,
}));

// Column objects only need to exist: predicates are built at module load but
// never executed (executeQuery is mocked).
jest.mock("@/lib/db/schema", () => {
  const cols = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, { name: n }]));
  return {
    contentAuditLogs: cols(
      "outcome", "action", "createdAt", "actorKind", "surface", "actorUserId", "agentLabel", "objectId"
    ),
    contentObjects: cols("id", "kind", "status", "collectionId"),
    contentCollections: cols("id", "name", "archivedAt"),
    users: cols("id", "firstName", "lastName", "email"),
  };
});

jest.mock("@/lib/content", () => {
  class MockValidationError extends Error {}
  return { ValidationError: MockValidationError };
});

import { getAtriumUsageStatsAction } from "@/actions/db/atrium/usage-stats";

const HEADLINE_ROW = {
  created: 12, updated: 30, published: 4, unpublished: 1, deleted: 2, collections: 3,
  created24h: 1, updated24h: 5, published24h: 0,
  created7d: 6, updated7d: 20, published7d: 2,
  human: 40, agent: 10, ui: 35, mcp: 10, rest: 5,
  authors7d: 3, authorsRange: 7, agentsRange: 2, errors: 1,
};

function rowsFor(operation: string): unknown[] {
  switch (operation) {
    case "atrium.usage.headline":
      return [HEADLINE_ROW];
    case "atrium.usage.kinds":
      return [{ kind: "document", count: 9 }];
    case "atrium.usage.topAuthors":
      return [
        { userId: 7, firstName: "Ada", lastName: null, email: "ada@example.com", created: 5, updated: 9, published: 1, total: 15 },
        { userId: null, firstName: null, lastName: null, email: null, created: 1, updated: 0, published: 0, total: 1 },
      ];
    case "atrium.usage.topAgents":
      return [{ label: null, created: 2, updated: 3, published: 0, total: 5 }];
    case "atrium.usage.topSections":
      return [{ collectionId: "c-1", name: "HR", total: 8 }];
    case "atrium.usage.daily":
      return [];
    case "atrium.usage.inventory":
      return [{ status: "published", count: 20 }, { status: "draft", count: 5 }];
    case "atrium.usage.collections":
      return [{ count: 4 }];
    default:
      throw new Error(`unexpected operation ${operation}`);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  getUserRequesterMock.mockResolvedValue({ kind: "user", userId: 1, roles: ["administrator"], isAdmin: true });
  executeQueryMock.mockImplementation(async (_fn: unknown, operation: string) => rowsFor(operation));
});

describe("getAtriumUsageStatsAction", () => {
  it("refuses a non-administrator before touching the database", async () => {
    getUserRequesterMock.mockResolvedValueOnce({ kind: "user", userId: 9, roles: ["staff"], isAdmin: false });

    const result = await getAtriumUsageStatsAction("30d");

    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("rejects a range outside the allowlist (including prototype keys) without querying", async () => {
    const result = await getAtriumUsageStatsAction("constructor" as unknown as "30d");

    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("shapes the grouped reads into the dashboard DTO for an administrator", async () => {
    const result = await getAtriumUsageStatsAction("7d");

    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    const s = result.data;
    expect(s.range).toBe("7d");
    expect(s.totals).toEqual({ created: 12, updated: 30, published: 4, unpublished: 1, deleted: 2, collections: 3 });
    expect(s.last24h).toEqual({ created: 1, updated: 5, published: 0 });
    expect(s.last7d).toEqual({ created: 6, updated: 20, published: 2 });
    expect(s.actors).toEqual({ human: 40, agent: 10 });
    expect(s.surfaces).toEqual({ ui: 35, mcp: 10, rest: 5 });
    expect(s.activeAuthors7d).toBe(3);
    expect(s.activeAgentsRange).toBe(2);
    expect(s.errorsRange).toBe(1);
    // A kind with no rows stays zero.
    expect(s.kinds).toEqual({ document: 9, artifact: 0 });
    // Authors without a user id are dropped; the display name falls back sensibly.
    expect(s.topAuthors).toEqual([
      { userId: 7, name: "Ada", email: "ada@example.com", created: 5, updated: 9, published: 1, total: 15 },
    ]);
    expect(s.topAgents).toEqual([{ label: "Agent", created: 2, updated: 3, published: 0, total: 5 }]);
    expect(s.topSections).toEqual([{ collectionId: "c-1", name: "HR", total: 8 }]);
    // 7d → seven zero-filled points.
    expect(s.daily).toHaveLength(7);
    expect(s.daily.every((d) => d.created === 0 && d.updated === 0 && d.published === 0)).toBe(true);
    expect(s.inventory).toEqual({ objects: 25, published: 20, drafts: 5, archived: 0, collections: 4 });
    // Eight reads: one headline pass + seven breakdowns.
    expect(executeQueryMock).toHaveBeenCalledTimes(8);
  });
});
