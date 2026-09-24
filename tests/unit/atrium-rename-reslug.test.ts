/** @jest-environment node */

/**
 * #1791 finding 3: the library's "Build it for me" flow titles a starter
 * artifact with the truncated PROMPT, and the slug was allocated once at create
 * (`uniqueSlug`, inside the create transaction) and never recomputed. So a
 * dashboard kept `/c/a-dashboard-of-chromebook-device-repairs-from-our-district-…`
 * forever — even after someone renamed it in Content settings, because
 * `applyTitleAndTags` writes `title` and nothing else.
 *
 * A rename now re-slugs, but ONLY while the object has never been published:
 * once a URL has been live somebody may have linked to it, so the slug must stay
 * stable from then on. These tests pin both halves of that rule, plus the fact
 * that the check happens INSIDE the rename transaction (under the row lock), so
 * a publish racing a rename cannot slip between the check and the write.
 */

jest.mock("@/lib/content/collection-access", () => ({
  collectionAccessSnapshot: jest.fn(),
  collectionAccessSnapshotInTx: jest.fn(),
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => true),
    assertWritableLevel: jest.fn(),
    applyGrantsForLevel: jest.fn(async () => undefined),
  },
}));
// Defined INSIDE the factory: `jest.mock` is hoisted above the file's consts,
// so referencing an outer binding here throws "cannot access before
// initialization". The table identities are read back below via requireMock.
jest.mock("@/lib/db/schema", () => ({
  contentAuditLogs: {},
  contentCollections: {},
  contentObjects: { id: {}, slug: {} },
  contentPublications: { id: {}, objectId: {}, destination: {} },
  contentVersions: {},
  navigationItems: {},
}));
const { contentPublications: CONTENT_PUBLICATIONS } = jest.requireMock(
  "@/lib/db/schema"
) as { contentPublications: unknown };
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (value: unknown) => JSON.stringify(value),
}));
jest.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  count: (value: unknown) => value,
  eq: (...args: unknown[]) => args,
  gte: (...args: unknown[]) => args,
  isNull: (value: unknown) => value,
  // Tagged so a prefix scan is distinguishable from the other shapes.
  like: (...args: unknown[]) => ({ like: args }),
  // Tagged so the self-exclusion is distinguishable from the lock's `eq`.
  ne: (...args: unknown[]) => ({ ne: args }),
  sql: Object.assign((..._args: unknown[]) => ({}), { join: () => ({}) }),
}));
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: { flushSnapshotWrites: jest.fn(async () => undefined) },
}));
jest.mock("@/lib/content/agent-screening", () => ({
  screenAgentBodyForWrite: jest.fn(async () => null),
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));

const OBJECT_ID = "11111111-1111-1111-1111-111111111111";
const lockedObject = {
  id: OBJECT_ID,
  kind: "artifact",
  title: "A dashboard of Chromebook/device repairs from our district data: repairs per…",
  slug: "a-dashboard-of-chromebook-device-repairs-from-our-district-data-repairs-per",
  ownerUserId: 7,
  collectionId: null,
  visibilityLevel: "private",
  status: "draft",
  tags: [],
};

/** Publication rows the in-transaction check will find (empty = never published). */
let publicationRows: Array<Record<string, unknown>> = [];
/** Slugs already taken, as `uniqueSlug`'s prefetch SELECT would report them. */
let takenSlugs: Array<{ slug: string }> = [];
/** Order in which the transaction touched each table, for the race assertion. */
let txSelects: string[] = [];
/** Conditions passed to each content_objects `.where(...)`, in order. */
let objectWheres: unknown[] = [];
let updatedValues: Record<string, unknown> | null = null;
/** Rows the pre-transaction `loadByIdOrSlug` returns. */
const outsideRows = () => [lockedObject];

const updateReturningMock = jest.fn(async () => [
  { ...lockedObject, ...(updatedValues ?? {}) },
]);
const updateSetMock = jest.fn((values: Record<string, unknown>) => {
  updatedValues = values;
  return { where: jest.fn(() => ({ returning: updateReturningMock })) };
});

/** `.where(...)` for the publication probe: chains a `.limit(1)`. */
function publicationsWhere() {
  return { limit: async () => publicationRows };
}

/**
 * `.where(...)` for a select on content_objects. Two callers with different
 * shapes share it: the row lock chains `.for("update").limit(1)`, while
 * `uniqueSlug`'s prefetch awaits the `where(...)` directly. A real promise, not
 * a shared thenable — a thenable re-runs per `.then()`.
 */
function objectsWhere(condition?: unknown) {
  objectWheres.push(condition);
  const lockable = { for: () => ({ limit: async () => [lockedObject] }) };
  return Object.assign(Promise.resolve(takenSlugs), lockable);
}

/**
 * A tx stub that dispatches on the TABLE each select targets, because the rename
 * path issues three structurally different selects: the `FOR UPDATE` row lock,
 * the publication probe, and `uniqueSlug`'s prefetch.
 */
function txFrom(table: unknown) {
  if (table === CONTENT_PUBLICATIONS) {
    txSelects.push("publications");
    return { where: publicationsWhere };
  }
  txSelects.push("objects");
  return { where: objectsWhere };
}

const txStub = {
  select: jest.fn(() => ({ from: txFrom })),
  update: jest.fn(() => ({ set: updateSetMock })),
};

// `loadByIdOrSlug` (the pre-transaction load in `update`) runs outside the
// transaction through executeQuery; everything the rename does runs inside it.
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => outsideRows()),
  executeTransaction: jest.fn(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub)
  ),
}));

import { contentService } from "@/lib/content/content-service";
import { ConflictError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const requester: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  publicationRows = [];
  takenSlugs = [];
  txSelects = [];
  objectWheres = [];
  updatedValues = null;
});

describe("rename re-slugs an unpublished object (#1791 finding 3)", () => {
  it("regenerates the slug from the new title while the object has never been published", async () => {
    await contentService.update(requester, OBJECT_ID, {
      title: "Device repairs dashboard",
    });

    expect(updatedValues?.title).toBe("Device repairs dashboard");
    expect(updatedValues?.slug).toBe("device-repairs-dashboard");
  });

  it("KEEPS the slug once the object has ever been published — links must not break", async () => {
    // A publication row is not deleted on unpublish; it flips to `unpublished`.
    // Once a URL has been live, the slug is frozen.
    publicationRows = [{ id: "pub-1" }];

    await contentService.update(requester, OBJECT_ID, {
      title: "Device repairs dashboard",
    });

    expect(updatedValues?.title).toBe("Device repairs dashboard");
    expect(updatedValues?.slug).toBeUndefined();
  });

  it("checks publication INSIDE the transaction, after the row lock", async () => {
    await contentService.update(requester, OBJECT_ID, { title: "Renamed" });
    // objects (FOR UPDATE lock) -> publications (probe) -> objects (uniqueSlug).
    expect(txSelects[0]).toBe("objects");
    expect(txSelects[1]).toBe("publications");
  });

  it("avoids a slug already taken rather than colliding", async () => {
    takenSlugs = [{ slug: "device-repairs-dashboard" }];

    await contentService.update(requester, OBJECT_ID, {
      title: "Device repairs dashboard",
    });

    expect(updatedValues?.slug).not.toBe("device-repairs-dashboard");
    expect(String(updatedValues?.slug)).toMatch(/^device-repairs-dashboard-/);
  });

  it("does NOT re-slug (or open a transaction) for a tags-only patch", async () => {
    await contentService.update(requester, OBJECT_ID, { tags: ["reports"] });

    expect(txStub.update).not.toHaveBeenCalled();
    expect(txSelects).toEqual([]);
  });

  it("excludes the object's OWN row from the collision scan (no -1 churn on a same-base rename)", async () => {
    await contentService.update(requester, OBJECT_ID, { title: "Renamed" });
    // The last objects select is `uniqueSlug`'s prefetch.
    const slugScan = objectWheres[objectWheres.length - 1] as unknown[];
    expect(slugScan).toContainEqual({ ne: [expect.anything(), OBJECT_ID] });
  });

  it("maps a slug unique-violation race on rename to a ConflictError, not a raw 500", async () => {
    updateReturningMock.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: "23505" })
    );

    await expect(
      contentService.update(requester, OBJECT_ID, { title: "Renamed" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("scans by the truncated prefix for a 200-char title, so an occupied shortened -1 is seen", async () => {
    const longTitle = "a".repeat(250);
    const base = "a".repeat(200);
    // `slugCandidate(base, 1)` is 198 a's + "-1" — NOT `${base}-%`.
    takenSlugs = [{ slug: base }, { slug: `${"a".repeat(198)}-1` }];

    await contentService.update(requester, OBJECT_ID, { title: longTitle });

    const slugScan = objectWheres[objectWheres.length - 1] as unknown[];
    expect(slugScan).toContainEqual({
      like: [expect.anything(), `${"a".repeat(189)}%`],
    });
    // Both occupied forms were seen, so the next free slot is taken.
    expect(updatedValues?.slug).toBe(`${"a".repeat(198)}-2`);
  });
});

