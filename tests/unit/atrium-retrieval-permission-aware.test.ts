/**
 * Integration tests for Atrium Phase 6 — permission-aware retrieval (Issue
 * #1056, Epic #1059). Spec §16 (retrieval), §28.2 (the safety boundary).
 *
 * The centerpiece (acceptance criterion §31.2): `retrievalService.search` runs
 * the existing vector search, then drops any hit the requester cannot
 * `canView`. A staff requester retrieves a group-scoped doc (grant → role
 * "staff") while a student requester does NOT — the structural guarantee a
 * student-facing assistant cannot pull staff-only content via RAG. Enforced
 * server-side, never by UI filtering.
 *
 * Only the IO boundaries are mocked (DB via `executeQuery`/`executeTransaction`,
 * vector search, embeddings, content/version/s3 loaders). The REAL
 * `visibilityService.canView` + `helpers.principalOf` run — `grantsFor` is
 * driven through the `executeQuery` label mock — so the test exercises the
 * ACTUAL permission predicate, not a stub of it.
 */

// --- mocks (hoisted above imports by jest) ---

// executeQuery is label-routed so the real visibilityService.grantsFor (label
// "content.grantsFor") and retrieval-service's own queries share one mock.
let repoLookupResult: unknown[] = [{ id: 1 }];
let resolveLinksResult: unknown[] = [];
let grantsForResult: Array<{ kind: string; value: string }> = [];
let loadAssistantScopeResult: unknown[] = [];

// Transaction proxy for indexObject: `.limit()`/`.returning()` yield the next
// queued result; `.insert(table)` records the table + array payloads so the
// "content is indexed" test can assert chunks were written; everything else
// stays fluent.
let txResults: unknown[] = [];
let txUpdateCalls = 0;
let insertedTables: unknown[] = [];
let insertedChunkPayload: Array<Record<string, unknown>> | null = null;
// Non-array insert payloads (repository_items, content_index_links) so tests can
// assert the repository_items.type mapping (document -> "document", artifact -> "text").
let insertedRows: Array<Record<string, unknown>> = [];

const shiftTx = () => (txResults.length ? txResults.shift() : []);
const txChain: Record<string, unknown> = {};
const txProxy: unknown = new Proxy(txChain, {
  get(_t, prop: string | symbol) {
    if (prop === "then") return undefined;
    if (prop === "returning" || prop === "limit") return () => shiftTx();
    if (prop === "update") {
      txUpdateCalls += 1;
      return () => txProxy;
    }
    if (prop === "insert") {
      return (table: unknown) => {
        insertedTables.push(table);
        return {
          then: undefined,
          values: (v: unknown) => {
            if (Array.isArray(v)) {
              insertedChunkPayload = v as Array<Record<string, unknown>>;
            } else {
              insertedRows.push(v as Record<string, unknown>);
            }
            return { then: undefined, returning: () => shiftTx() };
          },
        };
      };
    }
    return () => txProxy;
  },
});

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_fn: unknown, label: string) => {
    switch (label) {
      case "retrieval.getAtriumRepository":
        return repoLookupResult;
      case "retrieval.resolveLinks":
        return resolveLinksResult;
      case "retrieval.loadAssistantScope":
        return loadAssistantScopeResult;
      case "content.grantsFor":
        return grantsForResult;
      default:
        return [];
    }
  }),
  executeTransaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(txProxy)
  ),
}));

// Vector search + embeddings + chunker: pure IO boundaries.
let vectorSearchResult: Array<Record<string, unknown>> = [];
jest.mock("@/lib/repositories/search-service", () => ({
  vectorSearch: jest.fn(async () => vectorSearchResult),
}));
jest.mock("@/lib/ai-helpers", () => ({
  generateEmbeddings: jest.fn(async (chunks: string[]) =>
    chunks.map(() => [0.1, 0.2, 0.3])
  ),
}));
jest.mock("@/lib/document-processing", () => ({
  chunkText: (text: string) => (text.trim() ? [text] : []),
}));

// Object/version/s3 loaders. `loadByIdOrSlug` returns the doc under test.
// Outer vars are dereferenced only at call time (inside the async bodies), so
// the hoisted import of retrieval-service can run these factories before the
// `let`s' declaration lines without a TDZ error.
let loadedObject: unknown = null;
// Per-id map for multi-object tests; when null, every id resolves `loadedObject`.
let loadedObjectsById: Record<string, unknown> | null = null;
let currentVersion: unknown = { id: "ver-1", versionNumber: 3 };
let s3Text = "the full markdown body of the doc";
jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadByIdOrSlug: jest.fn(async (id: string) =>
      loadedObjectsById ? (loadedObjectsById[id] ?? null) : loadedObject
    ),
  },
}));
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: jest.fn(async () => currentVersion),
    loadArtifactCode: jest.fn(async () => "artifact source code"),
  },
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    key: (objectId: string, version: number, file: string) =>
      `atrium/objects/${objectId}/v${version}/${file}`,
    getText: jest.fn(async () => s3Text),
  },
}));

// mappers pulls drizzle-helpers; events pulls the AWS SNS client. Neither is
// exercised by canView/grantsFor — stub them so the real visibility-service +
// helpers load without dragging in AWS SDK (same pattern as the §26.4 gate test).
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (r: unknown) => r,
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn() },
}));

import {
  retrievalService,
  _resetAtriumRepositoryCacheForTests,
} from "@/lib/content/retrieval-service";
import {
  contentObjects,
  contentIndexLinks,
  repositoryItems,
  repositoryItemChunks,
} from "@/lib/db/schema";
import { s3Store } from "@/lib/content/storage/s3-store";
import { visibilityService } from "@/lib/content/visibility-service";
import type { Requester } from "@/lib/content/types";

// The mocked s3Store.getText, retrieved from the mocked module so §16.3 tests
// can assert it is (not) called without dereferencing it in a hoisted factory.
const getTextMock = s3Store.getText as jest.Mock;

// A staff user and a student user — both authenticated, neither admin.
const staffUser: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const studentUser: Requester = {
  kind: "user",
  userId: 20,
  roles: ["student"],
  isAdmin: false,
};

// A published, GROUP-visibility doc owned by someone else, granted to role
// "staff" only. `canView` allows the staff requester (role matches the grant)
// and denies the student (role does not) — the exact staff-vs-student split.
const groupStaffDoc = {
  id: "obj-1",
  kind: "document" as const,
  title: "Staff-only playbook",
  slug: "staff-playbook",
  ownerUserId: 999,
  collectionId: "col-hs-staff",
  visibilityLevel: "group" as const,
  tags: ["guide"],
  status: "published" as const,
};

const oneHit = {
  itemId: 100,
  chunkId: 5,
  itemName: "Staff-only playbook",
  content: "the matching chunk text",
  similarity: 0.92,
  chunkIndex: 0,
  metadata: {},
};

beforeEach(() => {
  _resetAtriumRepositoryCacheForTests();
  repoLookupResult = [{ id: 1 }];
  resolveLinksResult = [{ objectId: "obj-1", repositoryItemId: 100 }];
  grantsForResult = [{ kind: "role", value: "staff" }];
  loadAssistantScopeResult = [];
  vectorSearchResult = [oneHit];
  loadedObject = groupStaffDoc;
  loadedObjectsById = null;
  currentVersion = { id: "ver-1", versionNumber: 3 };
  s3Text = "the full markdown body of the doc";
  txResults = [];
  txUpdateCalls = 0;
  insertedTables = [];
  insertedChunkPayload = null;
  insertedRows = [];
  jest.clearAllMocks();
});

describe("§16.2 permission-aware search — the safety boundary", () => {
  it("RETURNS a group-scoped doc to a STAFF requester (role grant matches)", async () => {
    const hits = await retrievalService.search(staffUser, "playbook");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      objectId: "obj-1",
      slug: "staff-playbook",
      chunkId: 5,
      content: "the matching chunk text",
    });
  });

  it("EXCLUDES the same doc from a STUDENT requester (role grant does NOT match)", async () => {
    const hits = await retrievalService.search(studentUser, "playbook");
    expect(hits).toHaveLength(0);
  });

  it("EXCLUDES an internal-only doc from an unauthenticated requester", async () => {
    loadedObject = { ...groupStaffDoc, visibilityLevel: "internal" };
    const anon: Requester = {
      kind: "user",
      userId: null,
      roles: [],
      isAdmin: false,
    };
    const hits = await retrievalService.search(anon, "playbook");
    expect(hits).toHaveLength(0);
  });

  it("drops hits whose object is no longer published (never leaks drafts)", async () => {
    loadedObject = { ...groupStaffDoc, status: "draft" };
    const hits = await retrievalService.search(staffUser, "playbook");
    expect(hits).toHaveLength(0);
  });

  it("returns [] without touching visibility when vector search finds nothing", async () => {
    vectorSearchResult = [];
    const hits = await retrievalService.search(staffUser, "playbook");
    expect(hits).toEqual([]);
  });

  it("concurrent canView filtering keeps the ORIGINAL hit order and never checks status-excluded hits", async () => {
    // Three hits → three distinct objects, in vector-search (similarity) order.
    // obj-2 is a DRAFT: the cheap status pre-filter excludes it BEFORE the
    // (now-parallelized) canView batch, so it must never cost a canView call.
    vectorSearchResult = [
      { ...oneHit, itemId: 100, chunkId: 5, similarity: 0.95 },
      { ...oneHit, itemId: 101, chunkId: 6, similarity: 0.93 },
      { ...oneHit, itemId: 102, chunkId: 7, similarity: 0.91 },
    ];
    resolveLinksResult = [
      { objectId: "obj-1", repositoryItemId: 100 },
      { objectId: "obj-2", repositoryItemId: 101 },
      { objectId: "obj-3", repositoryItemId: 102 },
    ];
    loadedObjectsById = {
      "obj-1": { ...groupStaffDoc, id: "obj-1", slug: "doc-1" },
      "obj-2": { ...groupStaffDoc, id: "obj-2", slug: "doc-2", status: "draft" },
      "obj-3": { ...groupStaffDoc, id: "obj-3", slug: "doc-3" },
    };

    const canViewSpy = jest.spyOn(visibilityService, "canView");
    try {
      const hits = await retrievalService.search(staffUser, "playbook");

      // Same predicates as the sequential loop: published + in scope + canView.
      // Order is the ORIGINAL vector-search order (obj-1 before obj-3 by
      // similarity), never Promise completion order.
      expect(hits.map((h) => h.objectId)).toEqual(["obj-1", "obj-3"]);
      expect(hits.map((h) => h.chunkId)).toEqual([5, 7]);
      expect(hits.map((h) => h.similarity)).toEqual([0.95, 0.91]);

      // The draft hit was dropped by the cheap pre-filter — no canView DB call.
      const checkedIds = canViewSpy.mock.calls.map(([, obj]) => obj.id);
      expect(checkedIds).toEqual(["obj-1", "obj-3"]);
    } finally {
      canViewSpy.mockRestore();
    }
  });
});

describe("§16.4 assistant scoping — narrows candidates BEFORE canView", () => {
  it("excludes an otherwise-viewable doc when the assistant scope's collection does not match", async () => {
    loadAssistantScopeResult = [
      { retrievalScope: { collectionId: "some-other-collection" } },
    ];
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(0);
  });

  it("includes the doc for staff when the assistant scope's collection matches", async () => {
    loadAssistantScopeResult = [
      { retrievalScope: { collectionId: "col-hs-staff" } },
    ];
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].objectId).toBe("obj-1");
  });

  it("still denies student even when the scope matches (canView wins over scope)", async () => {
    loadAssistantScopeResult = [
      { retrievalScope: { collectionId: "col-hs-staff" } },
    ];
    const hits = await retrievalService.searchForAssistant(
      studentUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(0);
  });

  it("fails closed (returns []) when the assistant is not found", async () => {
    loadAssistantScopeResult = []; // no such assistant
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      99999,
      "playbook"
    );
    expect(hits).toHaveLength(0);
  });

  it("excludes a hit whose tags do not intersect the scope's tags", async () => {
    // Doc is tagged ["guide"]; scope requires ["policy"] — no overlap → excluded.
    loadAssistantScopeResult = [{ retrievalScope: { tags: ["policy"] } }];
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(0);
  });

  it("includes a hit when at least one scope tag intersects the doc's tags", async () => {
    loadAssistantScopeResult = [
      { retrievalScope: { tags: ["policy", "guide"] } },
    ];
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(1);
  });

  it("excludes a public doc when maxVisibilityLevel caps exposure at group", async () => {
    // maxVisibilityLevel ranks private<group<internal<public; a `public` doc
    // exceeds a `group` cap and is excluded (even though canView would allow it).
    loadedObject = { ...groupStaffDoc, visibilityLevel: "public" };
    loadAssistantScopeResult = [
      { retrievalScope: { maxVisibilityLevel: "group" } },
    ];
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(0);
  });

  it("includes a group doc when maxVisibilityLevel cap is internal", async () => {
    loadAssistantScopeResult = [
      { retrievalScope: { maxVisibilityLevel: "internal" } },
    ];
    const hits = await retrievalService.searchForAssistant(
      staffUser,
      42,
      "playbook"
    );
    expect(hits).toHaveLength(1);
  });
});

describe("§16.3 whole-object injection — getContextDocument", () => {
  it("returns the full document text to a permitted (staff) requester", async () => {
    const text = await retrievalService.getContextDocument(staffUser, "obj-1");
    expect(text).toBe("the full markdown body of the doc");
    expect(getTextMock).toHaveBeenCalled();
  });

  it("returns null to a requester who cannot view the object (student)", async () => {
    const text = await retrievalService.getContextDocument(
      studentUser,
      "obj-1"
    );
    expect(text).toBeNull();
    expect(getTextMock).not.toHaveBeenCalled();
  });

  it("returns null for an unpublished object", async () => {
    loadedObject = { ...groupStaffDoc, status: "draft" };
    const text = await retrievalService.getContextDocument(staffUser, "obj-1");
    expect(text).toBeNull();
  });
});

describe("§16.1 indexObject — published content is indexed", () => {
  it("chunks + embeds + writes repository item/chunks/link and stamps indexed_at", async () => {
    // NEW-index path: no existing link (limit → []), then created item id 100.
    txResults = [[], [{ id: 100 }]];

    await retrievalService.indexObject("obj-1");

    // The write transaction ran, inserted into all three retrieval tables, wrote
    // ≥1 chunk carrying an embedding, and stamped indexed_at (the update call).
    expect(insertedTables).toContain(repositoryItems);
    expect(insertedTables).toContain(repositoryItemChunks);
    expect(insertedTables).toContain(contentIndexLinks);
    expect(insertedChunkPayload).not.toBeNull();
    expect(insertedChunkPayload!.length).toBeGreaterThan(0);
    expect(insertedChunkPayload![0]).toMatchObject({
      content: expect.any(String),
      chunkIndex: 0,
    });
    expect(insertedChunkPayload![0].embedding).toBeDefined();
    expect(txUpdateCalls).toBeGreaterThan(0); // content_objects.indexed_at stamped
    // sanity: the stamped table is content_objects (imported to keep the ref used)
    expect(contentObjects).toBeDefined();
    // A document maps to repository_items.type = "document".
    const itemRow = insertedRows.find((r) => "type" in r);
    expect(itemRow?.type).toBe("document");
  });

  it("maps an ARTIFACT to repository_items.type = 'text' (CHECK allows only document|url|text)", async () => {
    // Regression: `type: obj.kind` would insert "artifact", violating the
    // repository_items.type CHECK — and because publish swallows index errors,
    // the artifact would publish but silently never index.
    loadedObject = { ...groupStaffDoc, kind: "artifact" };
    txResults = [[], [{ id: 101 }]];

    await retrievalService.indexObject("obj-1");

    const itemRow = insertedRows.find((r) => "type" in r);
    expect(itemRow?.type).toBe("text");
    expect(insertedChunkPayload!.length).toBeGreaterThan(0);
  });

  it("is a no-op for an object that is not published", async () => {
    loadedObject = { ...groupStaffDoc, status: "draft" };
    await retrievalService.indexObject("obj-1");
    expect(insertedTables).toHaveLength(0);
  });
});
