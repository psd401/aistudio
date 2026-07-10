/**
 * Unit tests for okfImportService.importBundle (Issue #1103, Phase 8, §36.3).
 *
 * Asserts the two guarantees the import path must get right, with the content
 * service mocked (so the ESM render stack + DB never load):
 *  - **Agent provenance** (acceptance #5): every imported object is written as the
 *    seeded `atrium-importer` agent-autonomous requester — actor_kind = 'agent',
 *    never fabricated human authorship — regardless of who triggered the import.
 *  - **Safe defaults**: imported objects are created private (never pre-widened),
 *    carry OKF source provenance, and round-trip the exporter's concept fields
 *    (title / body / tags) back into the create call.
 */

// content-service pulls in version-service → the ESM-only remark/rehype render
// stack (unloadable under jest CJS). Mock the service so importing import.ts stays
// lightweight; we grab a reference to the mock AFTER import (a const referenced
// inside the hoisted factory would hit a TDZ error).
jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    create: jest.fn(async (_req: unknown, input: Record<string, unknown>) => ({
      id: "obj-created",
      slug: "the-slug",
      title: (input as { title: string }).title,
      collectionId: (input as { collectionId?: string }).collectionId ?? null,
    })),
  },
}));

// executeQuery serves createCollection (nested dirs). The root-only tests pass a
// targetCollectionId, so no fresh collection is created there.
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => [{ id: "coll-new" }]),
}));

jest.mock("@/lib/db/schema", () => ({
  contentCollections: { id: "contentCollections.id" },
}));

import { contentService } from "@/lib/content/content-service";
import { executeQuery } from "@/lib/db/drizzle-client";
import { okfImportService, ATRIUM_IMPORT_AGENT_ID } from "@/lib/content/okf/import";

const createMock = contentService.create as jest.Mock;
const executeQueryMock = executeQuery as jest.Mock;
import { buildConceptFile, type ConceptSource } from "@/lib/content/okf/serialize";
import { serializeFrontmatter } from "@/lib/content/okf/frontmatter";
import { OKF_INDEX_FILE } from "@/lib/content/okf/profile";
import type { Requester } from "@/lib/content/types";
import { ForbiddenError, ValidationError } from "@/lib/content/errors";

const userCaller: Requester = {
  kind: "user",
  userId: 42,
  roles: ["staff"],
  isAdmin: false,
};

const docSource: ConceptSource = {
  kind: "document",
  title: "Fractions Unit",
  summary: "A summary",
  tags: ["math", "grade-5"],
  updatedAt: "2026-07-01T00:00:00.000Z",
  resource: null,
  bodyFormat: "markdown",
  body: "# Fractions\n\nContent.",
};

describe("okfImportService.importBundle — provenance + safe defaults", () => {
  beforeEach(() => {
    createMock.mockClear();
    executeQueryMock.mockClear();
  });

  it("reconstructs every ancestor collection for a nested concept path", async () => {
    // Bundle with a deeply nested file but NO file directly in the intermediate
    // `math/` dir — every ancestor collection must still be created (math + algebra).
    await okfImportService.importBundle(userCaller, {
      files: [{ path: "math/algebra/equations.md", content: buildConceptFile(docSource) }],
    });
    // createCollection is issued for the root ("") + "math" + "math/algebra" = 3.
    expect(executeQueryMock).toHaveBeenCalledTimes(3);
    // The concept lands in the deepest reconstructed collection.
    const [, input] = createMock.mock.calls[0];
    expect(input.collectionId).toBe("coll-new");
  });

  it("writes imported objects as the atrium-importer agent (actor_kind='agent')", async () => {
    const files = [
      { path: "fractions-unit.md", content: buildConceptFile(docSource) },
    ];
    const result = await okfImportService.importBundle(userCaller, {
      files,
      targetCollectionId: "target-coll",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const [req, input] = createMock.mock.calls[0];
    // The WRITE identity is the importer agent — NOT the human caller.
    expect((req as Requester).kind).toBe("agent-autonomous");
    expect((req as { agentId: string }).agentId).toBe(ATRIUM_IMPORT_AGENT_ID);
    expect((req as { kind: string }).kind).not.toBe("user");

    // Mapped fields round-trip from the exporter's concept file.
    expect(input.kind).toBe("document");
    expect(input.title).toBe("Fractions Unit");
    expect(input.body).toContain("# Fractions");
    expect(input.tags).toEqual(["math", "grade-5"]);
    // Safe defaults: private + OKF provenance.
    expect(input.visibility).toEqual({ level: "private" });
    expect(input.sourceRef).toMatchObject({ type: "okf" });

    expect(result.objectCount).toBe(1);
    expect(result.objects[0].id).toBe("obj-created");
    expect(result.rootCollectionId).toBe("target-coll");
  });

  it("extracts fenced artifact code into the create body", async () => {
    const artifact: ConceptSource = {
      ...docSource,
      kind: "artifact",
      bodyFormat: "html",
      body: "<h1>Hello</h1>",
    };
    await okfImportService.importBundle(userCaller, {
      files: [{ path: "widget.md", content: buildConceptFile(artifact) }],
      targetCollectionId: "target-coll",
    });
    const [, input] = createMock.mock.calls[0];
    expect(input.kind).toBe("artifact");
    expect(input.body).toBe("<h1>Hello</h1>");
    expect(input.bodyFormat).toBe("html");
  });

  it("extracts a tilde-fenced (~~~) artifact body from another producer", async () => {
    const content = [
      '---',
      'type: "artifact"',
      'title: "Tilde Widget"',
      '---',
      '',
      '~~~jsx',
      '<Widget/>',
      '~~~',
    ].join("\n");
    await okfImportService.importBundle(userCaller, {
      files: [{ path: "tilde.md", content }],
      targetCollectionId: "target-coll",
    });
    const [, input] = createMock.mock.calls[0];
    expect(input.kind).toBe("artifact");
    expect(input.body).toBe("<Widget/>");
    expect(input.bodyFormat).toBe("jsx");
  });

  it("skips reserved OKF files (index.md / log.md) as concepts", async () => {
    const files = [
      { path: OKF_INDEX_FILE, content: serializeFrontmatter({ type: "index", title: "Root" }) },
      { path: "log.md", content: "# Change history\n" },
      { path: "a.md", content: buildConceptFile(docSource) },
    ];
    await okfImportService.importBundle(userCaller, {
      files,
      targetCollectionId: "target-coll",
    });
    // Only the single concept file produced a create() call.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty bundle and a bundle with no concept files", async () => {
    await expect(
      okfImportService.importBundle(userCaller, { files: [] })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      okfImportService.importBundle(userCaller, {
        files: [{ path: OKF_INDEX_FILE, content: "---\ntype: index\n---\n" }],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("enforces content:create on the triggering caller (defense in depth)", async () => {
    const agentWithoutScope: Requester = {
      kind: "agent-autonomous",
      agentId: "some-agent",
      roleId: null,
      roles: [],
      scopes: [], // lacks content:create
      agentLabel: "no-scope-agent",
    };
    await expect(
      okfImportService.importBundle(agentWithoutScope, {
        files: [{ path: "a.md", content: buildConceptFile(docSource) }],
        targetCollectionId: "target-coll",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
