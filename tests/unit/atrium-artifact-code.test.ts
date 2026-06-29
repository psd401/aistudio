/**
 * Unit tests for versionService.loadArtifactCode + getById (#1052, Phase 2, §19.2).
 *
 * loadArtifactCode resolves an artifact version's UNTRUSTED source from wherever
 * it lives:
 *  - inline (body_location === "inline")  -> body_inline (or "" when null)
 *  - S3     (body_location === "<s3 key>") -> s3Store.getText(key)
 *  - markdown (a document version)         -> ValidationError (mis-routed caller)
 *
 * getById scopes the lookup to the object so a viewer of object A cannot load a
 * version of unrelated object B by guessing its id (the WHERE includes objectId).
 *
 * The S3 store + drizzle are mocked so this stays a pure-logic unit test.
 */

const getTextCalls: string[] = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => []),
  executeTransaction: jest.fn(async () => {
    throw new Error("loadArtifactCode/getById should not open a transaction");
  }),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "id", currentVersionId: "currentVersionId" },
  contentVersions: { id: "id", objectId: "objectId", versionNumber: "versionNumber" },
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
  stripJsonQuotes: (v: unknown) => (typeof v === "string" ? v.replace(/^"|"$/g, "") : v),
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    key: (objectId: string, v: number, file: string) => `atrium/objects/${objectId}/v${v}/${file}`,
    getText: jest.fn(async (key: string) => {
      getTextCalls.push(key);
      return `S3_CODE_FOR(${key})`;
    }),
  },
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {},
}));

import { versionService } from "@/lib/content/version-service";
import { ValidationError } from "@/lib/content/errors";
import type { ContentVersionDTO } from "@/lib/content/types";

function makeVersion(overrides: Partial<ContentVersionDTO>): ContentVersionDTO {
  return {
    id: "v-1",
    objectId: "obj-1",
    versionNumber: 1,
    authorActor: "agent",
    authorUserId: null,
    authorAgentId: "agent-x",
    bodyFormat: "html",
    bodyLocation: "inline",
    bodyInline: null,
    renderLocation: null,
    proofDocRef: null,
    summary: null,
    createdAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getTextCalls.length = 0;
});

describe("versionService.loadArtifactCode", () => {
  it("returns inline body verbatim without touching S3", async () => {
    const v = makeVersion({
      bodyFormat: "html",
      bodyLocation: "inline",
      bodyInline: "<h1>inline artifact</h1>",
    });
    const code = await versionService.loadArtifactCode(v);
    expect(code).toBe("<h1>inline artifact</h1>");
    expect(getTextCalls).toHaveLength(0);
  });

  it("returns empty string for an inline version with null body_inline (no crash)", async () => {
    const v = makeVersion({ bodyLocation: "inline", bodyInline: null });
    expect(await versionService.loadArtifactCode(v)).toBe("");
    expect(getTextCalls).toHaveLength(0);
  });

  it("reads from S3 at body_location for a larger artifact", async () => {
    const key = "atrium/objects/obj-1/v2/artifact.html";
    const v = makeVersion({ versionNumber: 2, bodyFormat: "html", bodyLocation: key });
    const code = await versionService.loadArtifactCode(v);
    expect(code).toBe(`S3_CODE_FOR(${key})`);
    expect(getTextCalls).toEqual([key]);
  });

  it("supports jsx artifacts stored in S3", async () => {
    const key = "atrium/objects/obj-1/v3/artifact.jsx";
    const v = makeVersion({ versionNumber: 3, bodyFormat: "jsx", bodyLocation: key });
    expect(await versionService.loadArtifactCode(v)).toBe(`S3_CODE_FOR(${key})`);
  });

  it("throws ValidationError when called on a markdown (document) version", async () => {
    const v = makeVersion({ bodyFormat: "markdown", bodyLocation: "proof" });
    await expect(versionService.loadArtifactCode(v)).rejects.toBeInstanceOf(ValidationError);
    expect(getTextCalls).toHaveLength(0);
  });
});

describe("versionService.getById", () => {
  // Re-mock executeQuery per test to assert the object-scoped WHERE behavior.
  const drizzle = jest.requireMock("@/lib/db/drizzle-client") as {
    executeQuery: jest.Mock;
  };

  it("returns null when no row matches (wrong object or absent version)", async () => {
    drizzle.executeQuery.mockResolvedValueOnce([]);
    const result = await versionService.getById("obj-1", "v-other");
    expect(result).toBeNull();
  });

  it("maps a matching row to a version DTO", async () => {
    drizzle.executeQuery.mockResolvedValueOnce([
      {
        id: "v-9",
        objectId: "obj-1",
        versionNumber: 9,
        authorActor: "human",
        authorUserId: 42,
        authorAgentId: null,
        bodyFormat: "html",
        bodyLocation: "inline",
        bodyInline: "<p>x</p>",
        renderLocation: null,
        proofDocRef: null,
        summary: null,
        createdAt: null,
      },
    ]);
    const result = await versionService.getById("obj-1", "v-9");
    expect(result?.id).toBe("v-9");
    expect(result?.versionNumber).toBe(9);
    expect(result?.authorActor).toBe("human");
  });
});
