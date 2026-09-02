/**
 * `contentService.create` and `contentService.update` refuse `dataAccess` on a
 * document (#1705).
 *
 * Both create surfaces (REST + MCP) already drop the field for documents. The
 * update path is where every surface converges, so the guard lives in the
 * service: a document can never carry a stray `query` mode that a future
 * `content.dataAccess` consumer might trust without re-checking `kind`.
 */

const rows: Array<Array<Record<string, unknown>>> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  // Serves loadByIdOrSlug and the UPDATE ... RETURNING in call order.
  executeQuery: jest.fn(async () => rows.shift() ?? []),
  executeTransaction: jest.fn(async () => {
    throw new Error("update should not open a transaction");
  }),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "id", slug: "slug" },
  contentCollections: {},
  contentVersions: {},
}));
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (v: unknown) => JSON.stringify(v),
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  like: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), { join: () => ({}) }),
}));
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => true),
    assertWritableLevel: jest.fn(),
    applyGrantsForLevel: jest.fn(),
  },
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));
jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: { snapshot: jest.fn(), flushSnapshotWrites: jest.fn() },
}));

import { executeQuery } from "@/lib/db/drizzle-client";
import { contentService } from "@/lib/content/content-service";
import { ValidationError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const owner: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

const baseObj = {
  id: "11111111-1111-1111-1111-111111111111",
  ownerUserId: 7,
  visibilityLevel: "internal",
  status: "draft",
  tags: [],
  dataAccess: "records",
};

beforeEach(() => {
  rows.length = 0;
  (executeQuery as jest.Mock).mockClear();
});

describe("contentService.create: dataAccess is artifact-only", () => {
  it("refuses a document created with a data-access mode before any DB work", async () => {
    await expect(
      contentService.create(owner, {
        kind: "document",
        title: "Not a sandbox",
        body: "hello",
        bodyFormat: "markdown",
        dataAccess: "query",
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(executeQuery).not.toHaveBeenCalled();
  });
});

describe("contentService.update: dataAccess is artifact-only", () => {
  it("refuses to write a data-access mode onto a document", async () => {
    rows.push([{ ...baseObj, kind: "document" }]); // loadByIdOrSlug

    await expect(
      contentService.update(owner, baseObj.id, { dataAccess: "query" })
    ).rejects.toBeInstanceOf(ValidationError);
    // Only the lookup ran; the UPDATE never went out.
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it("writes the mode for an artifact", async () => {
    rows.push(
      [{ ...baseObj, kind: "artifact" }],
      [{ ...baseObj, kind: "artifact", dataAccess: "query" }]
    );

    const updated = await contentService.update(owner, baseObj.id, {
      dataAccess: "query",
    });

    expect(updated.dataAccess).toBe("query");
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it("leaves a document alone when no mode is supplied", async () => {
    rows.push(
      [{ ...baseObj, kind: "document" }],
      [{ ...baseObj, kind: "document", title: "Renamed" }]
    );

    const updated = await contentService.update(owner, baseObj.id, {
      title: "Renamed",
    });

    expect(updated.title).toBe("Renamed");
  });
});
