/**
 * Unit tests for `retrievalService.removeFromIndex` (Epic #1059 completion) —
 * the inverse of `indexObject`: deletes the backing repository_item + chunks +
 * content_index_links row and clears `content_objects.indexed_at`, all in one
 * transaction; a silent no-op when the object was never indexed.
 *
 * Also covers the re-publish round-trip: after a prune, `indexObject` sees no
 * link and takes its INSERT path (fresh item + link), so re-publishing
 * re-indexes cleanly.
 *
 * Mocking mirrors atrium-retrieval-permission-aware.test.ts: only the IO
 * boundaries (drizzle, embeddings, chunker, content/version/s3 loaders) are
 * stubbed; the real service logic runs.
 */

// --- mocks (hoisted above imports by jest) ---

let outerQueryResults: Record<string, unknown[]> = {};

// Transaction recording proxy: `.limit()`/`.returning()` shift queued results;
// `.delete(table)`/`.update(table)`/`.insert(table)` record the table (by its
// mocked sentinel) so tests can assert exactly which rows were touched.
let txResults: unknown[] = [];
let deletedTables: string[] = [];
let updatedTables: string[] = [];
let updateSetPayloads: Array<Record<string, unknown>> = [];
let insertedTables: string[] = [];

const tableName = (t: unknown): string =>
  (t as { __table?: string })?.__table ?? "unknown";

const shiftTx = () => (txResults.length ? txResults.shift() : []);
const txChain: Record<string, unknown> = {};
const txProxy: unknown = new Proxy(txChain, {
  get(_t, prop: string | symbol) {
    if (prop === "then") return undefined;
    if (prop === "returning" || prop === "limit") return () => shiftTx();
    if (prop === "delete") {
      return (table: unknown) => {
        deletedTables.push(tableName(table));
        return txProxy;
      };
    }
    if (prop === "update") {
      return (table: unknown) => {
        updatedTables.push(tableName(table));
        return txProxy;
      };
    }
    if (prop === "set") {
      return (payload: Record<string, unknown>) => {
        updateSetPayloads.push(payload);
        return txProxy;
      };
    }
    if (prop === "insert") {
      return (table: unknown) => {
        insertedTables.push(tableName(table));
        return txProxy;
      };
    }
    return () => txProxy;
  },
});

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_cb: unknown, label: string) => {
    return outerQueryResults[label] ?? [];
  }),
  executeTransaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(txProxy)
  ),
}));

jest.mock("@/lib/db/schema", () => ({
  contentIndexLinks: {
    __table: "content_index_links",
    id: "cil.id",
    objectId: "cil.objectId",
    repositoryItemId: "cil.repositoryItemId",
  },
  contentObjects: { __table: "content_objects", id: "co.id" },
  knowledgeRepositories: {
    __table: "knowledge_repositories",
    id: "kr.id",
    name: "kr.name",
  },
  repositoryItemChunks: { __table: "repository_item_chunks", itemId: "ric.itemId" },
  repositoryItems: { __table: "repository_items", id: "ri.id" },
  assistantArchitects: { __table: "assistant_architects", id: "aa.id" },
}));

jest.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => a,
  inArray: (...a: unknown[]) => a,
}));

jest.mock("@/lib/document-processing", () => ({
  chunkText: (text: string) => (text.trim() ? [text] : []),
}));
jest.mock("@/lib/ai-helpers", () => ({
  generateEmbeddings: jest.fn(async (chunks: string[]) =>
    chunks.map(() => [0.1, 0.2])
  ),
}));
jest.mock("@/lib/repositories/search-service", () => ({
  vectorSearch: jest.fn(async () => []),
}));

let loadedObject: Record<string, unknown> | null = null;
jest.mock("@/lib/content/content-service", () => ({
  contentService: { loadByIdOrSlug: jest.fn(async () => loadedObject) },
}));
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: jest.fn(async () => ({ id: "ver-1", versionNumber: 3 })),
    loadArtifactCode: jest.fn(async () => "code"),
  },
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => true),
    grantsFor: jest.fn(async () => []),
  },
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    key: (...parts: unknown[]) => parts.join("/"),
    getText: jest.fn(async () => "the doc body"),
  },
}));
jest.mock("@/lib/content/helpers", () => ({
  systemUserId: () => 42,
}));

import { retrievalService } from "@/lib/content/retrieval-service";
import { executeTransaction } from "@/lib/db/drizzle-client";

const txMock = executeTransaction as jest.Mock;

beforeEach(() => {
  outerQueryResults = {
    "retrieval.getAtriumRepository": [{ id: 1 }],
  };
  txResults = [];
  deletedTables = [];
  updatedTables = [];
  updateSetPayloads = [];
  insertedTables = [];
  loadedObject = null;
  txMock.mockClear();
});

describe("retrievalService.removeFromIndex", () => {
  it("deletes chunks, link, and item, then clears indexed_at", async () => {
    // The link SELECT finds the indexed object's link row.
    txResults = [[{ id: 7, repositoryItemId: 55 }]];

    await retrievalService.removeFromIndex("obj-1");

    // Chunks first, then the link (it references the item), then the item.
    expect(deletedTables).toEqual([
      "repository_item_chunks",
      "content_index_links",
      "repository_items",
    ]);
    // indexed_at is cleared on the content row.
    expect(updatedTables).toEqual(["content_objects"]);
    expect(updateSetPayloads).toEqual([{ indexedAt: null }]);
  });

  it("is an idempotent no-op when the object was never indexed", async () => {
    txResults = [[]]; // link SELECT finds nothing

    await retrievalService.removeFromIndex("obj-unindexed");

    expect(deletedTables).toEqual([]);
    expect(updatedTables).toEqual([]);
    // Repeat call: still a clean no-op.
    txResults = [[]];
    await expect(
      retrievalService.removeFromIndex("obj-unindexed")
    ).resolves.toBeUndefined();
  });
});

describe("re-publish after a prune re-indexes cleanly", () => {
  it("indexObject takes the fresh-INSERT path when no link remains", async () => {
    loadedObject = {
      id: "obj-1",
      kind: "document",
      slug: "doc-1",
      title: "Doc 1",
      collectionId: null,
      visibilityLevel: "internal",
      tags: [],
      status: "published",
    };
    // tx queue: link SELECT → [] (pruned), item INSERT RETURNING → new item id.
    txResults = [[], [{ id: 77 }]];

    await retrievalService.indexObject("obj-1");

    // A fresh repository_item, its chunks, and a fresh link were all inserted —
    // the round-trip invariant: prune leaves no state that blocks re-indexing.
    expect(insertedTables).toEqual([
      "repository_items",
      "repository_item_chunks",
      "content_index_links",
    ]);
    // indexed_at is re-stamped.
    expect(updatedTables).toContain("content_objects");
  });
});
