/**
 * Unit tests for okfExportService.exportCollection (Issue #1103, Phase 8, §36.2).
 *
 * Asserts the security-critical surface — permission-at-export — with the DB and
 * downstream services mocked:
 *  - **canView filter** (acceptance #3): the bundle contains exactly the objects
 *    the permission-pushed `listVisible` returns — nothing the requester cannot see.
 *  - **§26.4 public gate** (acceptance #4): a `public` bundle requested WITHOUT
 *    `content:publish_public` (a non-admin human, or ANY autonomous agent) is
 *    blocked with ApprovalRequiredError before any object is read; a public bundle
 *    additionally carries only `visibility_level = 'public'` objects.
 *  - **collection-name boundary (P1, chatgpt-codex review):** the subtree comes
 *    from `collectionService.tree(req)` (the visibility-filtered reader tree), so a
 *    section the requester cannot enter is NEVER named in the bundle.
 */

// --- mocks (hoisted) ---

// The visibility-filtered collection tree the export walks. Set per test; a
// non-visible section is simply absent from it (that IS the P1 guarantee).
type TreeNode = { id: string; name: string; slug: string; parentId: string | null; children: TreeNode[]; visibleObjectCount: number };
let visibleTree: TreeNode[] = [];
function node(id: string, over: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, slug: id, parentId: null, children: [], visibleObjectCount: 0, ...over };
}

jest.mock("@/lib/content/collection-service", () => ({
  collectionService: { tree: jest.fn(async () => visibleTree) },
}));

jest.mock("@/lib/db/drizzle-client", () => ({
  // Only priorPublication reads via executeQuery now → empty.
  executeQuery: jest.fn(async () => []),
}));

jest.mock("@/lib/db/schema", () => ({
  contentPublications: {
    objectId: "objectId",
    status: "status",
    externalRef: "externalRef",
  },
}));

// version-service pulls the ESM render stack; retrieval-service pulls the vector
// stack. Mock both plus s3Store + events so importing export.ts stays lightweight.
// Each mock's jest.fn is defined INSIDE its (hoisted) factory; references are
// grabbed AFTER import to clear/assert (a const referenced in the factory itself
// would hit a TDZ error). `visibleObjects` is a module `let` read at CALL time.
let visibleObjects: Array<Record<string, unknown>> = [];
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { listVisible: jest.fn(async () => visibleObjects) },
}));

jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: jest.fn(async () => ({
      versionNumber: 1,
      summary: "sum",
      bodyFormat: "markdown",
      authorActor: "human",
      createdAt: "2026-07-01T00:00:00.000Z",
    })),
    list: jest.fn(async () => [
      { versionNumber: 1, authorActor: "human", summary: "sum", createdAt: "2026-07-01T00:00:00.000Z" },
    ]),
  },
}));

jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: {
    getContextDocument: jest.fn(async (_req: unknown, objectId: string) => `# Body of ${objectId}`),
  },
}));

jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    okfBundleKey: jest.fn(() => "atrium/okf/root/exp.json"),
    putText: jest.fn(async () => undefined),
    signedReadUrl: jest.fn(async () => "https://signed/bundle"),
  },
}));

jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));

import { okfExportService } from "@/lib/content/okf/export";
import { visibilityService } from "@/lib/content/visibility-service";
import { retrievalService } from "@/lib/content/retrieval-service";
import { collectionService } from "@/lib/content/collection-service";
import { s3Store } from "@/lib/content/storage/s3-store";
import { contentEvents } from "@/lib/content/events";
import { ApprovalRequiredError, NotFoundError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const listVisibleMock = visibilityService.listVisible as jest.Mock;
const getContextDocumentMock = retrievalService.getContextDocument as jest.Mock;
const treeMock = collectionService.tree as jest.Mock;
const putTextMock = s3Store.putText as jest.Mock;
const emitMock = contentEvents.emit as jest.Mock;

const staffUser: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const adminUser: Requester = {
  kind: "user",
  userId: 1,
  roles: ["administrator"],
  isAdmin: true,
};
const autonomousAgent: Requester = {
  kind: "agent-autonomous",
  agentId: "agent-1",
  roleId: null,
  roles: ["staff"],
  scopes: ["content:read"],
  agentLabel: "reader-agent",
};

function objectDTO(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "obj-1",
    kind: "document",
    title: "Doc One",
    slug: "doc-one",
    tags: ["t"],
    updatedAt: "2026-07-01T00:00:00.000Z",
    visibilityLevel: "internal",
    status: "published",
    ...over,
  };
}

describe("okfExportService.exportCollection — permission boundary", () => {
  beforeEach(() => {
    // Default: a single visible root collection (no children).
    visibleTree = [node("root", { name: "Root", slug: "root" })];
    visibleObjects = [];
    listVisibleMock.mockClear();
    getContextDocumentMock.mockClear();
    treeMock.mockClear();
    putTextMock.mockClear();
    emitMock.mockClear();
  });

  it("serializes exactly the objects listVisible returns (canView filter)", async () => {
    visibleObjects = [objectDTO({ id: "student-doc", slug: "student-doc" })];
    const result = await okfExportService.exportCollection(staffUser, "root");

    // The permission-pushed predicate is the filter — export never widens it.
    expect(listVisibleMock).toHaveBeenCalled();
    expect(result.bundle.objectCount).toBe(1);
    const paths = result.bundle.files.map((f) => f.path);
    expect(paths).toContain("student-doc.md");
    // index.md + log.md are always present for the collection.
    expect(paths).toContain("index.md");
    expect(paths).toContain("log.md");
    // A staff-only object the SQL predicate dropped is simply absent.
    expect(paths).not.toContain("staff-only.md");
    // Bundle was persisted to S3; its location is returned.
    expect(putTextMock).toHaveBeenCalled();
    expect(result.url).toBe("https://signed/bundle");
  });

  it("only names collections the requester can enter (P1 — no hidden-section leak)", async () => {
    // The visibility-filtered tree contains root + one enterable child ("math").
    // A private sibling the requester cannot enter is simply ABSENT from the tree,
    // so it can never be named in the bundle.
    visibleTree = [
      node("root", {
        name: "Root",
        slug: "root",
        children: [node("math", { name: "Mathematics", slug: "math", parentId: "root" })],
      }),
    ];
    visibleObjects = [];
    const result = await okfExportService.exportCollection(staffUser, "root");
    const paths = result.bundle.files.map((f) => f.path);
    expect(paths).toContain("index.md");
    expect(paths).toContain("math/index.md");
    // The root index links only the visible child, never a hidden section.
    const rootIndex = result.bundle.files.find((f) => f.path === "index.md")!.content;
    expect(rootIndex).toContain("Mathematics");
    expect(rootIndex).not.toContain("secret");
    // Only the two visible collections are counted.
    expect(result.bundle.collectionCount).toBe(2);
  });

  it("blocks a public bundle for a non-admin human lacking content:publish_public", async () => {
    visibleObjects = [objectDTO()];
    await expect(
      okfExportService.exportCollection(staffUser, "root", { audience: "public" })
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    // The gate runs BEFORE any object is read.
    expect(listVisibleMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalled(); // approval-queue signal emitted
  });

  it("blocks a public bundle for ANY autonomous agent (structurally denied)", async () => {
    visibleObjects = [objectDTO()];
    await expect(
      okfExportService.exportCollection(autonomousAgent, "root", { audience: "public" })
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(listVisibleMock).not.toHaveBeenCalled();
  });

  it("allows a public bundle for an admin, restricted to public-visibility objects", async () => {
    visibleObjects = [
      objectDTO({ id: "pub", slug: "pub", visibilityLevel: "public" }),
      objectDTO({ id: "internal", slug: "internal", visibilityLevel: "internal" }),
    ];
    const result = await okfExportService.exportCollection(adminUser, "root", {
      audience: "public",
    });
    const paths = result.bundle.files.map((f) => f.path);
    expect(paths).toContain("pub.md");
    // The internal object is dropped — a public bundle carries only public content.
    expect(paths).not.toContain("internal.md");
    expect(result.bundle.objectCount).toBe(1);
    expect(result.bundle.audience).toBe("public");
  });

  it("allows an internal bundle without the public gate (student/staff self-export)", async () => {
    visibleObjects = [objectDTO()];
    const result = await okfExportService.exportCollection(staffUser, "root", {
      audience: "internal",
    });
    expect(result.bundle.audience).toBe("internal");
    expect(result.bundle.objectCount).toBe(1);
  });

  it("404s a root collection the requester cannot enter (absent from the visible tree)", async () => {
    visibleTree = [node("root", { name: "Root", slug: "root" })];
    await expect(
      okfExportService.exportCollection(staffUser, "missing")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("disambiguates concept filenames colliding with reserved and each other (no duplicate paths)", async () => {
    // A slug of literally "index" is renamed off the reserved index.md; a real
    // "index-concept" slug in the same directory then takes a `-2` suffix so no two
    // concepts (and neither reserved file) ever share a bundle `path`.
    visibleObjects = [
      objectDTO({ id: "a", slug: "index", title: "A" }),
      objectDTO({ id: "b", slug: "index-concept", title: "B" }),
    ];
    const result = await okfExportService.exportCollection(staffUser, "root");
    const paths = result.bundle.files.map((f) => f.path);
    expect(paths).toContain("index.md"); // reserved navigation file, still distinct
    expect(paths).toContain("index-concept.md"); // the renamed "index" slug
    expect(paths).toContain("index-concept-2.md"); // the real "index-concept" slug
    // Invariant: every path in the bundle is unique.
    expect(new Set(paths).size).toBe(paths.length);
  });
});
