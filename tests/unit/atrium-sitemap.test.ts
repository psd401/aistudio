/**
 * Unit tests for app/sitemap.ts (Epic #1059 — Atrium public reader SEO).
 *
 * The security-relevant assertion is the QUERY GATE: the sitemap must filter on
 * exactly the /p/[slug] public-gate conditions (visibility_level='public' AND a
 * live public_web publication) plus the status='published' subset guard — so it
 * can never advertise a URL the public reader would 404 (existence leak +
 * crawler soft-404s).
 *
 * Also covered: the fail-soft contract (empty sitemap + log.warn on a DB error
 * or a missing ATRIUM_PUBLIC_BASE_URL — never a throw) and the entry mapping
 * through publicReaderLink (the single /p/ URL builder).
 */

// --- mocks (hoisted above imports by jest) ---

const mockExecuteQuery = jest.fn();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...a: unknown[]) => mockExecuteQuery(...a),
}));

// Column tokens are plain strings so the captured eq/and tuples are directly
// comparable.
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {
    id: "co.id",
    slug: "co.slug",
    updatedAt: "co.updated_at",
    visibilityLevel: "co.visibility_level",
    status: "co.status",
  },
  contentPublications: {
    objectId: "cp.object_id",
    destination: "cp.destination",
    status: "cp.status",
  },
}));

jest.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ["eq", a, b],
  and: (...args: unknown[]) => ["and", ...args],
}));

// The real surface-helpers module pulls the DB client; mock the link builder to
// a deterministic absolute URL.
jest.mock("@/lib/content/surface-helpers", () => ({
  publicReaderLink: (slug: string) => `https://app.test/p/${slug}`,
}));

const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: mockWarn,
    error: jest.fn(),
  }),
}));

import sitemap from "@/app/sitemap";

/** Drives the real query-builder callback against a fake chainable db and
 * captures the innerJoin + where conditions. */
function stubQuery(rows: unknown[]): {
  joinConditions: unknown[];
  whereConditions: unknown[];
} {
  const joinConditions: unknown[] = [];
  const whereConditions: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: (_table: unknown, cond: unknown) => {
          joinConditions.push(cond);
          return {
            where: (cond2: unknown) => {
              whereConditions.push(cond2);
              return Promise.resolve(rows);
            },
          };
        },
      }),
    }),
  };
  mockExecuteQuery.mockImplementation(
    async (cb: (d: typeof db) => Promise<unknown>) => cb(db)
  );
  return { joinConditions, whereConditions };
}

const ORIGINAL_BASE = process.env.ATRIUM_PUBLIC_BASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ATRIUM_PUBLIC_BASE_URL = "https://app.test";
});

afterAll(() => {
  if (ORIGINAL_BASE === undefined) {
    delete process.env.ATRIUM_PUBLIC_BASE_URL;
  } else {
    process.env.ATRIUM_PUBLIC_BASE_URL = ORIGINAL_BASE;
  }
});

describe("app/sitemap.ts — Atrium public reader sitemap", () => {
  it("filters on EXACTLY the /p/[slug] public gate + the published-status subset guard", async () => {
    const { joinConditions, whereConditions } = stubQuery([]);

    await sitemap();

    // Join: publications keyed to the object.
    expect(joinConditions).toEqual([["eq", "cp.object_id", "co.id"]]);
    // Gate: strict public visibility + live public_web publication + published
    // lifecycle — a strict subset of what the reader page renders, so the
    // sitemap can never name a URL that 404s.
    expect(whereConditions).toEqual([
      [
        "and",
        ["eq", "co.visibility_level", "public"],
        ["eq", "cp.destination", "public_web"],
        ["eq", "cp.status", "live"],
        ["eq", "co.status", "published"],
      ],
    ]);
  });

  it("maps rows to publicReaderLink URLs with lastModified", async () => {
    const updatedAt = new Date("2026-07-01T12:00:00Z");
    stubQuery([
      { slug: "ai-guidelines", updatedAt },
      { slug: "no-timestamp", updatedAt: null },
    ]);

    const entries = await sitemap();

    expect(entries).toEqual([
      { url: "https://app.test/p/ai-guidelines", lastModified: updatedAt },
      { url: "https://app.test/p/no-timestamp" },
    ]);
  });

  it("fails soft to an EMPTY sitemap (log.warn, no throw) on a DB error", async () => {
    mockExecuteQuery.mockRejectedValue(new Error("db unreachable"));

    const entries = await sitemap();

    expect(entries).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      "Failed to build sitemap; serving empty sitemap",
      expect.objectContaining({ error: "db unreachable" })
    );
  });

  it("fails soft to an EMPTY sitemap when ATRIUM_PUBLIC_BASE_URL is unset (no relative URLs)", async () => {
    delete process.env.ATRIUM_PUBLIC_BASE_URL;

    const entries = await sitemap();

    expect(entries).toEqual([]);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      "ATRIUM_PUBLIC_BASE_URL not set; serving empty sitemap"
    );
  });
});
