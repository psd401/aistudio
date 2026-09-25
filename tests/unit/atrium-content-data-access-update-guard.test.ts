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
const getByIdMock = jest.fn();
const loadArtifactCodeSafeMock = jest.fn();
jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: {
    snapshot: jest.fn(),
    flushSnapshotWrites: jest.fn(),
    getById: (...a: unknown[]) => getByIdMock(...a),
    loadArtifactCodeSafe: (...a: unknown[]) => loadArtifactCodeSafeMock(...a),
  },
}));
const livePublishedVersionIdMock = jest.fn();
jest.mock("@/lib/content/live-publication", () => ({
  livePublishedVersionId: (...a: unknown[]) => livePublishedVersionIdMock(...a),
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
  getByIdMock.mockReset();
  loadArtifactCodeSafeMock.mockReset();
  livePublishedVersionIdMock.mockReset();
  livePublishedVersionIdMock.mockResolvedValue(null);
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

/**
 * #1789 — the mode change must reach the DRAFT the author is editing and NEVER
 * the version a live publication pins.
 */
describe("contentService.update: the mode change follows the draft, not Live", () => {
  const artifact = {
    ...baseObj,
    kind: "artifact",
    currentVersionId: "ver-head",
  };

  it("stamps the head version when it is NOT the live published version", async () => {
    // Scenario A: Live at v3, author working on draft v4. Stamping v4 gives the
    // author's preview the new mode while v3 keeps the one it was published
    // with.
    rows.push(
      [artifact],
      [{ ...artifact, dataAccess: "query" }],
      [] // the content_versions UPDATE
    );
    livePublishedVersionIdMock.mockResolvedValue("ver-published");

    const updated = await contentService.update(owner, artifact.id, {
      dataAccess: "query",
    });

    expect(updated.dataAccess).toBe("query");
    // lookup + object UPDATE + head stamp. No version was forked.
    expect(executeQuery).toHaveBeenCalledTimes(3);
    expect(executeQuery).toHaveBeenLastCalledWith(
      expect.any(Function),
      "content.dataAccess.stampHead"
    );
    expect(updated.currentVersionId).toBe("ver-head");
  });

  it("stamps the head of an artifact that is not published at all", async () => {
    rows.push([artifact], [{ ...artifact, dataAccess: "none" }], []);
    livePublishedVersionIdMock.mockResolvedValue(null);

    await contentService.update(owner, artifact.id, { dataAccess: "none" });

    expect(executeQuery).toHaveBeenLastCalledWith(
      expect.any(Function),
      "content.dataAccess.stampHead"
    );
  });

  it("forks a new version instead of re-capabilitying the LIVE one", async () => {
    // The head IS what readers are running. Stamping it would change what the
    // Live page can do for everyone, right now, with no republish — the bug.
    rows.push([artifact], [{ ...artifact, dataAccess: "query" }]);
    livePublishedVersionIdMock.mockResolvedValue("ver-head");
    getByIdMock.mockResolvedValue({
      id: "ver-head",
      bodyFormat: "html",
      dataAccess: "records",
    });
    loadArtifactCodeSafeMock.mockResolvedValue("<p>live</p>");
    const createVersion = jest
      .spyOn(contentService, "createVersion")
      .mockResolvedValue({
        ...artifact,
        currentVersionId: "ver-new",
      } as unknown as Awaited<ReturnType<typeof contentService.createVersion>>);

    try {
      const updated = await contentService.update(owner, artifact.id, {
        dataAccess: "query",
      });

      expect(createVersion).toHaveBeenCalledWith(
        owner,
        artifact.id,
        expect.objectContaining({ body: "<p>live</p>", dataAccess: "query" })
      );
      // The returned head is the FORK, so a caller re-reading it does not hand
      // back the version the Live page is still pinned to.
      expect(updated.currentVersionId).toBe("ver-new");
      // No in-place stamp went out.
      expect(executeQuery).toHaveBeenCalledTimes(2);
    } finally {
      createVersion.mockRestore();
    }
  });

  it("leaves Live alone rather than forking when the head body is unreadable", async () => {
    // `loadArtifactCodeSafe` degrades to "" on a missing/unreadable body, and an
    // empty snapshot would be rejected. Live keeping its capability is the safe
    // outcome; the next real save stamps the new mode.
    rows.push([artifact], [{ ...artifact, dataAccess: "query" }]);
    livePublishedVersionIdMock.mockResolvedValue("ver-head");
    getByIdMock.mockResolvedValue({ id: "ver-head", bodyFormat: "html" });
    loadArtifactCodeSafeMock.mockResolvedValue("");
    const createVersion = jest.spyOn(contentService, "createVersion");

    try {
      const updated = await contentService.update(owner, artifact.id, {
        dataAccess: "query",
      });

      expect(createVersion).not.toHaveBeenCalled();
      expect(updated.currentVersionId).toBe("ver-head");
      expect(executeQuery).toHaveBeenCalledTimes(2);
    } finally {
      createVersion.mockRestore();
    }
  });

  it("does nothing extra for an artifact that has no versions yet", async () => {
    const fresh = { ...artifact, currentVersionId: null };
    rows.push([fresh], [{ ...fresh, dataAccess: "query" }]);

    await contentService.update(owner, fresh.id, { dataAccess: "query" });

    // The next version will be stamped from the object's mode at snapshot time.
    expect(livePublishedVersionIdMock).not.toHaveBeenCalled();
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });
});
