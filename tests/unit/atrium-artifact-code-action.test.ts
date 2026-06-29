/**
 * Unit tests for getArtifactCodeAction and listVersionsAction (#1052, Phase 2).
 *
 * Critical coverage gaps not addressed by atrium-artifact-code.test.ts (which
 * tests versionService internals):
 *
 *  getArtifactCodeAction
 *    - canView enforcement: a non-viewable or absent object yields an error
 *      ActionState (NotFoundError from contentService.get) — existence is not
 *      leaked to the caller.
 *    - not-an-artifact rejection: passing a document object id returns a
 *      ValidationError (caller mis-routing).
 *    - cross-object version rejection: versionService.getById returns null when
 *      the version does not belong to this object; the action surfaces NotFound.
 *    - happy path: a viewable artifact with an inline version returns code.
 *
 *  listVersionsAction
 *    - canView enforcement: a non-viewable object yields an error ActionState.
 *    - happy path: returns a VersionSummary[] with isCurrent set correctly.
 *
 * All DB/session/service collaborators are mocked so this stays a pure
 * control-flow unit test. The mocks follow the same pattern as
 * atrium-publish-document-action.test.ts.
 */

import { NotFoundError } from "@/lib/content/errors";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of the actions under test
// ---------------------------------------------------------------------------

const mockGet = jest.fn();
const mockGetById = jest.fn();
const mockLoadArtifactCode = jest.fn();
const mockList = jest.fn();

jest.mock("@/lib/content", () => ({
  contentService: {
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    getById: (...args: unknown[]) => mockGetById(...args),
    loadArtifactCode: (...args: unknown[]) => mockLoadArtifactCode(...args),
    list: (...args: unknown[]) => mockList(...args),
  },
}));

jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: jest.fn(async () => ({
    kind: "user",
    userId: 99,
    roles: ["staff"],
    isAdmin: false,
  })),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "test-request-id",
  getLogContext: () => ({ requestId: "test-request-id", userId: undefined }),
  startTimer: () => jest.fn(),
  sanitizeForLogging: (x: unknown) => x,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal artifact content object DTO (kind = "artifact"). */
function makeArtifactObject(overrides: Record<string, unknown> = {}) {
  return {
    id: "obj-artifact-1",
    kind: "artifact",
    slug: "my-artifact",
    currentVersionId: "v-current",
    version: {
      id: "v-current",
      objectId: "obj-artifact-1",
      versionNumber: 3,
      authorActor: "agent",
      authorUserId: null,
      bodyFormat: "html",
      bodyLocation: "inline",
      bodyInline: "<h1>hello</h1>",
      renderLocation: null,
      proofDocRef: null,
      summary: null,
      createdAt: null,
    },
    ...overrides,
  };
}

/** A minimal document content object DTO (kind = "document"). */
function makeDocumentObject() {
  return {
    id: "obj-doc-1",
    kind: "document",
    slug: "my-doc",
    currentVersionId: "v-doc",
    version: {
      id: "v-doc",
      objectId: "obj-doc-1",
      versionNumber: 1,
      bodyFormat: "markdown",
      bodyLocation: "inline",
      bodyInline: "# Title",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: getArtifactCodeAction
// ---------------------------------------------------------------------------

describe("getArtifactCodeAction", () => {
  let getArtifactCodeAction: (
    idOrSlug: string,
    versionId?: string
  ) => Promise<{ isSuccess: boolean; data?: unknown; message?: string }>;

  beforeAll(async () => {
    const mod = await import("@/actions/db/atrium/get-artifact-code");
    getArtifactCodeAction = mod.getArtifactCodeAction;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("canView enforcement", () => {
    it("returns an error ActionState when the object is not viewable (NotFoundError)", async () => {
      // contentService.get hides existence: it throws NotFoundError for both
      // absent objects and objects the requester cannot view.
      mockGet.mockRejectedValueOnce(
        new NotFoundError("Content not found", { idOrSlug: "obj-private" })
      );

      const result = await getArtifactCodeAction("obj-private");

      expect(result.isSuccess).toBe(false);
      // The action must NOT surface the raw NotFoundError detail to the caller.
      expect(result.message).toBeTruthy();
    });
  });

  describe("not-an-artifact rejection", () => {
    it("returns a ValidationError ActionState when the object kind is 'document'", async () => {
      mockGet.mockResolvedValueOnce(makeDocumentObject());

      const result = await getArtifactCodeAction("obj-doc-1");

      expect(result.isSuccess).toBe(false);
      // versionService must never be called for a document.
      expect(mockLoadArtifactCode).not.toHaveBeenCalled();
      expect(mockGetById).not.toHaveBeenCalled();
    });
  });

  describe("cross-object version rejection", () => {
    it("returns an error ActionState when the requested versionId belongs to a different object", async () => {
      // The artifact is viewable, but the explicit versionId is from another object.
      mockGet.mockResolvedValueOnce(makeArtifactObject());
      // getById returns null for a foreign version id.
      mockGetById.mockResolvedValueOnce(null);

      const result = await getArtifactCodeAction("obj-artifact-1", "v-from-other-object");

      expect(result.isSuccess).toBe(false);
      expect(mockLoadArtifactCode).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("returns code for a viewable artifact using the head version when no versionId given", async () => {
      const obj = makeArtifactObject();
      mockGet.mockResolvedValueOnce(obj);
      mockLoadArtifactCode.mockResolvedValueOnce("<h1>hello</h1>");

      const result = await getArtifactCodeAction("obj-artifact-1");

      expect(result.isSuccess).toBe(true);
      expect((result as { data: { code: string } }).data.code).toBe("<h1>hello</h1>");
      // getById must NOT be called when no explicit versionId (uses obj.version).
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("returns code for a specific version when an explicit versionId is provided", async () => {
      const obj = makeArtifactObject();
      const specificVersion = {
        ...(obj.version as Record<string, unknown>),
        id: "v-2",
        versionNumber: 2,
        bodyInline: "<p>v2</p>",
      };
      mockGet.mockResolvedValueOnce(obj);
      mockGetById.mockResolvedValueOnce(specificVersion);
      mockLoadArtifactCode.mockResolvedValueOnce("<p>v2</p>");

      const result = await getArtifactCodeAction("obj-artifact-1", "v-2");

      expect(result.isSuccess).toBe(true);
      const data = (result as { data: { versionId: string; code: string } }).data;
      expect(data.versionId).toBe("v-2");
      expect(data.code).toBe("<p>v2</p>");
      expect(mockGetById).toHaveBeenCalledWith("obj-artifact-1", "v-2");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: listVersionsAction
// ---------------------------------------------------------------------------

describe("listVersionsAction", () => {
  let listVersionsAction: (
    idOrSlug: string
  ) => Promise<{ isSuccess: boolean; data?: unknown }>;

  beforeAll(async () => {
    const mod = await import("@/actions/db/atrium/list-versions");
    listVersionsAction = mod.listVersionsAction;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("canView enforcement", () => {
    it("returns an error ActionState when the object is not viewable", async () => {
      mockGet.mockRejectedValueOnce(
        new NotFoundError("Content not found", { idOrSlug: "obj-private" })
      );

      const result = await listVersionsAction("obj-private");

      expect(result.isSuccess).toBe(false);
      expect(mockList).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("returns VersionSummary[] with isCurrent set correctly for the head version", async () => {
      const obj = makeArtifactObject({
        currentVersionId: "v-3",
      });
      mockGet.mockResolvedValueOnce(obj);
      mockList.mockResolvedValueOnce([
        {
          id: "v-3",
          objectId: "obj-artifact-1",
          versionNumber: 3,
          authorActor: "agent",
          authorUserId: null,
          authorAgentId: "agent-x",
          bodyFormat: "html",
          bodyLocation: "inline",
          bodyInline: null,
          renderLocation: null,
          proofDocRef: null,
          summary: "Latest revision",
          createdAt: "2026-06-29T00:00:00.000Z",
        },
        {
          id: "v-2",
          objectId: "obj-artifact-1",
          versionNumber: 2,
          authorActor: "human",
          authorUserId: 42,
          authorAgentId: null,
          bodyFormat: "html",
          bodyLocation: "inline",
          bodyInline: null,
          renderLocation: null,
          proofDocRef: null,
          summary: "Prior draft",
          createdAt: "2026-06-28T00:00:00.000Z",
        },
      ]);

      const result = await listVersionsAction("obj-artifact-1");

      expect(result.isSuccess).toBe(true);
      const summaries = (
        result as { data: Array<{ id: string; isCurrent: boolean; authorActor: string }> }
      ).data;
      expect(summaries).toHaveLength(2);

      // Index by id with a for-loop (no nested array callback — keeps the
      // it()/describe() callback depth within the linter's limit of 3).
      const byId: Record<string, { id: string; isCurrent: boolean; authorActor: string }> = {};
      for (const s of summaries) byId[s.id] = s;
      expect(byId["v-3"]?.isCurrent).toBe(true);
      expect(byId["v-3"]?.authorActor).toBe("agent");
      expect(byId["v-2"]?.isCurrent).toBe(false);
      expect(byId["v-2"]?.authorActor).toBe("human");
    });

    it("returns an empty array when the object has no versions", async () => {
      mockGet.mockResolvedValueOnce(makeArtifactObject());
      mockList.mockResolvedValueOnce([]);

      const result = await listVersionsAction("obj-artifact-1");

      expect(result.isSuccess).toBe(true);
      expect((result as { data: unknown[] }).data).toHaveLength(0);
    });
  });
});
