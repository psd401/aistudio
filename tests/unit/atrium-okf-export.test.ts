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
 */

// --- mocks (hoisted) ---

const rootCollectionRow = { id: "root", name: "Root", slug: "root", parentId: null };
let collectionsRows: Array<{ id: string; name: string; slug: string; parentId: string | null }> = [
  rootCollectionRow,
];

jest.mock("@/lib/db/drizzle-client", () => ({
  // loadAllCollections → the collection rows; priorPublication (and anything
  // else) → empty. Keyed on the operation label so the two reads are distinct.
  executeQuery: jest.fn(async (_cb: unknown, label?: string) => {
    if (label === "okf.export.loadCollections") return collectionsRows;
    return [];
  }),
}));

jest.mock("@/lib/db/schema", () => ({
  contentCollections: {
    id: "id",
    name: "name",
    slug: "slug",
    parentId: "parentId",
    position: "position",
  },
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
import { s3Store } from "@/lib/content/storage/s3-store";
import { contentEvents } from "@/lib/content/events";
import { ApprovalRequiredError, NotFoundError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const listVisibleMock = visibilityService.listVisible as jest.Mock;
const getContextDocumentMock = retrievalService.getContextDocument as jest.Mock;
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
    collectionsRows = [rootCollectionRow];
    visibleObjects = [];
    listVisibleMock.mockClear();
    getContextDocumentMock.mockClear();
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

  it("404s an unknown root collection", async () => {
    collectionsRows = [rootCollectionRow];
    await expect(
      okfExportService.exportCollection(staffUser, "missing")
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
