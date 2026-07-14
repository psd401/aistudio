/**
 * Unit tests for the listVisible tag + query filters (Epic #1059 completion).
 *
 *  - Tag filter: must use the array-overlap form (`tags && ARRAY[$1]::text[]`)
 *    so the `idx_content_tags` GIN index (migration 085) applies — the previous
 *    `<tag> = ANY(tags)` form forced a sequential scan. The tag stays a bound
 *    parameter (injection-safe) and is length-clamped.
 *  - Query filter: case-insensitive title substring search, clamped to 200
 *    chars, with LIKE metacharacters (`\`, `%`, `_`) escaped so user text can
 *    never act as a wildcard pattern.
 *
 * drizzle-orm's `sql`/`ilike` are mocked as CAPTURING fakes so the exact
 * template chunks / bound values the service builds can be asserted without a
 * database.
 */

const executeQueryMock = jest.fn();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {
    id: "COL_id",
    ownerUserId: "COL_owner",
    visibilityLevel: "COL_visibility",
    collectionId: "COL_collection",
    kind: "COL_kind",
    status: "COL_status",
    tags: "COL_tags",
    title: "COL_title",
    updatedAt: "COL_updated_at",
  },
  contentVisibilityGrants: {},
  // listVisible LEFT JOINs users to project the owner display name.
  users: {
    id: "U_id",
    firstName: "U_first",
    lastName: "U_last",
    email: "U_email",
  },
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
  stripJsonQuotes: (v: unknown) => v,
}));

/** A captured sql`` invocation: raw template chunks + interpolated values. */
interface CapturedSql {
  op: "sql";
  chunks: string[];
  values: unknown[];
}
interface CapturedIlike {
  op: "ilike";
  column: unknown;
  pattern: unknown;
}
interface CapturedEq {
  op: "eq";
  a: unknown[];
}

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => ({ op: "eq", a }),
  ne: (...a: unknown[]) => ({ op: "ne", a }),
  ilike: (column: unknown, pattern: unknown) => ({ op: "ilike", column, pattern }),
  sql: Object.assign(
    (chunks: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      chunks: [...chunks],
      values,
    }),
    { join: (..._a: unknown[]) => ({ op: "sql-join" }) }
  ),
}));

import { visibilityService } from "@/lib/content/visibility-service";
import type { Requester } from "@/lib/content/types";

const staffUser: Requester = {
  kind: "user",
  userId: 100,
  roles: ["staff"],
  isAdmin: false,
};

/**
 * Drive listVisible with a filter and capture the flattened `.where()` filter
 * list (the array `and(...)` receives under the mocked drizzle-orm).
 */
async function captureFilters(
  filter: Record<string, unknown>
): Promise<unknown[]> {
  let captured: unknown[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "leftJoin", "orderBy", "limit"]) {
    builder[m] = jest.fn(() => builder);
  }
  builder.where = jest.fn((arg: unknown) => {
    captured = arg as unknown[];
    return builder;
  });
  builder.offset = jest.fn(() => Promise.resolve([]));
  executeQueryMock.mockImplementationOnce((cb: (db: unknown) => unknown) =>
    cb(builder)
  );
  await visibilityService.listVisible(
    staffUser,
    filter as Parameters<typeof visibilityService.listVisible>[1]
  );
  return captured;
}

const isSql = (f: unknown): f is CapturedSql =>
  typeof f === "object" && f !== null && (f as { op?: string }).op === "sql";
const isIlike = (f: unknown): f is CapturedIlike =>
  typeof f === "object" && f !== null && (f as { op?: string }).op === "ilike";
const isEq = (f: unknown): f is CapturedEq =>
  typeof f === "object" && f !== null && (f as { op?: string }).op === "eq";

/** Find the `<status> <> 'archived'` default-exclusion guard, if present. */
const archivedGuard = (filters: unknown[]): CapturedSql | undefined =>
  filters.filter(isSql).find((f) => f.chunks.some((c) => c.includes("<> 'archived'")));
/** Find the top-level equality filter on the status column, if present. */
const statusEq = (filters: unknown[]): CapturedEq | undefined =>
  filters.filter(isEq).find((f) => f.a[0] === "COL_status");

beforeEach(() => {
  executeQueryMock.mockReset();
});

describe("listVisible tag filter (GIN-usable overlap form)", () => {
  it("builds `tags && ARRAY[$tag]::text[]` with the tag as a bound value", async () => {
    const filters = await captureFilters({ tag: "science" });
    const tagFilter = filters
      .filter(isSql)
      .find((f) => f.chunks.some((c) => c.includes("&&")));
    expect(tagFilter).toBeDefined();
    // Overlap against a bound single-element array — the GIN-indexable form.
    expect(tagFilter!.chunks.join("?")).toContain("&& ARRAY[");
    expect(tagFilter!.chunks.join("?")).toContain("]::text[]");
    // Column first, then the bound tag value (never string-concatenated).
    expect(tagFilter!.values).toEqual(["COL_tags", "science"]);
  });

  it("clamps an oversized tag to 100 chars before binding", async () => {
    const filters = await captureFilters({ tag: "x".repeat(500) });
    const tagFilter = filters
      .filter(isSql)
      .find((f) => f.chunks.some((c) => c.includes("&&")));
    expect(tagFilter!.values[1]).toBe("x".repeat(100));
  });
});

describe("listVisible query filter (title ILIKE)", () => {
  it("builds an ILIKE on title with a %-wrapped bound pattern", async () => {
    const filters = await captureFilters({ query: "budget report" });
    const q = filters.find(isIlike);
    expect(q).toBeDefined();
    expect(q!.column).toBe("COL_title");
    expect(q!.pattern).toBe("%budget report%");
  });

  it("escapes LIKE metacharacters so user text cannot act as a wildcard", async () => {
    const filters = await captureFilters({ query: String.raw`50%_off\deal` });
    const q = filters.find(isIlike);
    expect(q!.pattern).toBe(String.raw`%50\%\_off\\deal%`);
  });

  it("clamps the query to 200 chars before escaping", async () => {
    const filters = await captureFilters({ query: "a".repeat(1000) });
    const q = filters.find(isIlike);
    // 200 payload chars + the two wrapping wildcards.
    expect(q!.pattern).toBe(`%${"a".repeat(200)}%`);
  });

  it("adds no title filter when query is absent or empty", async () => {
    expect((await captureFilters({})).find(isIlike)).toBeUndefined();
    expect((await captureFilters({ query: "" })).find(isIlike)).toBeUndefined();
  });
});

describe("listVisible status filter (archived visibility)", () => {
  it("excludes archived rows by default (`status <> 'archived'`, no status eq)", async () => {
    // The Library's default view (and every non-archived chip) sends no status,
    // and the service must then hide archived rows — the exact behavior the new
    // "Archived" chip is the sole opt-out for. A regression here would leak
    // archived content into the default library.
    const filters = await captureFilters({});
    const guard = archivedGuard(filters);
    expect(guard).toBeDefined();
    // The column is a bound value, never string-concatenated into the SQL.
    expect(guard!.values).toEqual(["COL_status"]);
    // No equality narrowing on status when none was requested.
    expect(statusEq(filters)).toBeUndefined();
  });

  it("returns ONLY archived rows for status:'archived' (eq, and drops the guard)", async () => {
    // The "Archived" chip maps to `status: 'archived'`. It must switch to an
    // equality filter AND drop the `<> 'archived'` guard — keeping the guard
    // would exclude the very rows the view exists to show.
    const filters = await captureFilters({ status: "archived" });
    const eq = statusEq(filters);
    expect(eq).toBeDefined();
    expect(eq!.a).toEqual(["COL_status", "archived"]);
    expect(archivedGuard(filters)).toBeUndefined();
  });

  it("narrows to a single status for draft/published without the archived guard", async () => {
    for (const status of ["draft", "published"] as const) {
      const filters = await captureFilters({ status });
      expect(statusEq(filters)!.a).toEqual(["COL_status", status]);
      expect(archivedGuard(filters)).toBeUndefined();
    }
  });
});

describe("listVisible owner-name projection (#1052)", () => {
  /**
   * Capture the `.select()` projection and the `.leftJoin()` args so we can assert
   * the owner display name rides on a LEFT JOIN of `users` — WITHOUT mutating the
   * shared `objectSelectFields` (single-object loads must stay join-free).
   */
  async function captureSelectAndJoin(): Promise<{
    select: Record<string, unknown>;
    joinArgs: unknown[];
  }> {
    let select: Record<string, unknown> = {};
    let joinArgs: unknown[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.select = jest.fn((arg: unknown) => {
      select = arg as Record<string, unknown>;
      return builder;
    });
    builder.leftJoin = jest.fn((...args: unknown[]) => {
      joinArgs = args;
      return builder;
    });
    builder.offset = jest.fn(() => Promise.resolve([]));
    executeQueryMock.mockImplementationOnce((cb: (db: unknown) => unknown) =>
      cb(builder)
    );
    await visibilityService.listVisible(staffUser, {});
    return { select, joinArgs };
  }

  it("projects `ownerName` as an sql expression and LEFT JOINs users", async () => {
    const { select, joinArgs } = await captureSelectAndJoin();
    // ownerName is added to the LIST projection (an sql expression), on top of the
    // shared object fields — never a plain column, so the JOIN backs it.
    expect(isSql(select.ownerName)).toBe(true);
    const ownerSql = select.ownerName as CapturedSql;
    // The display-name expression references the joined users columns + email
    // fallback (bound values, not string-concatenated).
    expect(ownerSql.values).toEqual(
      expect.arrayContaining(["U_first", "U_last", "U_email"])
    );
    // The shared object columns still ride along (projection was extended, not
    // replaced) — guards the "do not change objectSelectFields" contract.
    expect(select.id).toBe("COL_id");
    expect(select.title).toBe("COL_title");
    // LEFT JOIN users ON users.id = contentObjects.ownerUserId.
    expect(joinArgs[0]).toEqual({
      id: "U_id",
      firstName: "U_first",
      lastName: "U_last",
      email: "U_email",
    });
    const on = joinArgs[1] as CapturedEq;
    expect(on.op).toBe("eq");
    expect(on.a).toEqual(["U_id", "COL_owner"]);
  });
});
