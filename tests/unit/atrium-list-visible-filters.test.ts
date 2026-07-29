/**
 * Unit tests for the listVisible tag + query + since filters.
 *
 *  - Tag filter: CASE-INSENSITIVE whole-tag equality via `lower() = lower()`
 *    over `unnest(tags)` (#1336 review) — tags are stored case-preserved, so
 *    the earlier case-sensitive `&&` overlap zero-matched "science" against a
 *    stored "Science" while the free-text arm matched it via ILIKE. The tag
 *    stays a bound parameter (injection-safe) and is length-clamped.
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
jest.mock("@/lib/content/collection-access", () => ({
  collectionAccessSnapshot: jest.fn(async () => ({
    allowedCollectionIds: new Set<string>(),
  })),
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
interface CapturedGte {
  op: "gte";
  a: unknown[];
}

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => ({ op: "eq", a }),
  gte: (...a: unknown[]) => ({ op: "gte", a }),
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
const isGte = (f: unknown): f is CapturedGte =>
  typeof f === "object" && f !== null && (f as { op?: string }).op === "gte";

/** Find the `<status> <> 'archived'` default-exclusion guard, if present. */
const archivedGuard = (filters: unknown[]): CapturedSql | undefined =>
  filters.filter(isSql).find((f) => f.chunks.some((c) => c.includes("<> 'archived'")));
/** Find the top-level equality filter on the status column, if present. */
const statusEq = (filters: unknown[]): CapturedEq | undefined =>
  filters.filter(isEq).find((f) => f.a[0] === "COL_status");

beforeEach(() => {
  executeQueryMock.mockReset();
});

/** Find the exact-tag chip predicate by its distinctive `exact_tag` alias. */
const exactTagFilter = (filters: unknown[]): CapturedSql | undefined =>
  filters
    .filter(isSql)
    .find((f) => f.chunks.some((c) => c.includes("lower(exact_tag)")));

describe("listVisible tag filter (case-insensitive whole-tag match — #1336)", () => {
  it("builds a lower()=lower() EXISTS over unnest(tags) with the tag as a bound value", async () => {
    const filters = await captureFilters({ tag: "Science" });
    const tagFilter = exactTagFilter(filters);
    expect(tagFilter).toBeDefined();
    const shape = tagFilter!.chunks.join("?");
    expect(shape).toContain("EXISTS");
    expect(shape).toContain("unnest(");
    // Both sides case-folded: a stored "Science" must match a typed "science"
    // and vice versa — the same answer the free-text ILIKE arm gives.
    expect(shape).toContain("lower(exact_tag) = lower(");
    // Column first, then the bound tag value (never string-concatenated, and
    // NOT pre-lowercased in JS — the fold happens in SQL on both sides).
    expect(tagFilter!.values).toEqual(["COL_tags", "Science"]);
  });

  it("clamps an oversized tag to 100 chars before binding", async () => {
    const filters = await captureFilters({ tag: "x".repeat(500) });
    const tagFilter = exactTagFilter(filters);
    expect(tagFilter!.values[1]).toBe("x".repeat(100));
  });
});

/**
 * Find the free-text `query` predicate. Since #1336 it is a single `sql`
 * fragment ORing a title ILIKE with a per-TAG ILIKE over `unnest(tags)`, so the
 * `ilike()` call is a VALUE inside that fragment rather than a top-level filter.
 * Keyed on the `search_tag` alias — the exact-tag chip predicate also uses
 * `unnest(` (under the `exact_tag` alias), so `unnest(` alone is ambiguous.
 */
const queryFilter = (filters: unknown[]): CapturedSql | undefined =>
  filters
    .filter(isSql)
    .find((f) => f.chunks.some((c) => c.includes("search_tag")));

/** The title `ilike()` nested inside the query fragment. */
const queryTitleIlike = (filters: unknown[]): CapturedIlike | undefined => {
  const frag = queryFilter(filters);
  return frag?.values.find(isIlike);
};

describe("listVisible query filter (title OR tag ILIKE — #1336)", () => {
  it("builds an ILIKE on title with a %-wrapped bound pattern", async () => {
    const filters = await captureFilters({ query: "budget report" });
    const q = queryTitleIlike(filters);
    expect(q).toBeDefined();
    expect(q!.column).toBe("COL_title");
    expect(q!.pattern).toBe("%budget report%");
  });

  it("ORs a per-TAG ILIKE over unnest(tags) so a tag search matches", async () => {
    // #1336 A1: the library search box searches titles AND tags. `unnest` (not
    // the `&&` overlap the exact-match `tag` filter uses) is required because
    // overlap can only test equality, never a substring.
    const filters = await captureFilters({ query: "phoenix" });
    const frag = queryFilter(filters);
    expect(frag).toBeDefined();
    const sqlText = frag!.chunks.join("?");
    expect(sqlText).toContain("OR EXISTS");
    expect(sqlText).toContain("unnest(");
    expect(sqlText).toContain("search_tag ILIKE");
    // The tags COLUMN and the pattern are bound values, never concatenated.
    expect(frag!.values).toContain("COL_tags");
    expect(frag!.values).toContain("%phoenix%");
  });

  it("escapes LIKE metacharacters so user text cannot act as a wildcard", async () => {
    const filters = await captureFilters({ query: String.raw`50%_off\deal` });
    const escaped = String.raw`%50\%\_off\\deal%`;
    expect(queryTitleIlike(filters)!.pattern).toBe(escaped);
    // The tag arm binds the SAME escaped pattern — a wildcard must not slip
    // through the arm the title check does not cover.
    expect(queryFilter(filters)!.values).toContain(escaped);
  });

  it("clamps the query to 200 chars before escaping", async () => {
    const filters = await captureFilters({ query: "a".repeat(1000) });
    // 200 payload chars + the two wrapping wildcards.
    expect(queryTitleIlike(filters)!.pattern).toBe(`%${"a".repeat(200)}%`);
  });

  it("adds no query filter when query is absent or empty", async () => {
    expect(queryFilter(await captureFilters({}))).toBeUndefined();
    expect(queryFilter(await captureFilters({ query: "" }))).toBeUndefined();
  });
});

describe("listVisible since filter (#1414)", () => {
  it("uses an inclusive updated_at >= timestamp predicate", async () => {
    const since = "2026-07-27T12:34:56.789Z";
    const filters = await captureFilters({ since });
    const predicate = filters.find(isGte);

    expect(predicate).toBeDefined();
    expect(predicate!.a[0]).toBe("COL_updated_at");
    expect(predicate!.a[1]).toBeInstanceOf(Date);
    expect((predicate!.a[1] as Date).toISOString()).toBe(since);
  });

  it("adds no updated_at predicate when since is omitted", async () => {
    expect((await captureFilters({})).find(isGte)).toBeUndefined();
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
