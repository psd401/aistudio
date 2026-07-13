/**
 * Regression test for Atrium hard delete: an embed that points at a HARD-DELETED
 * artifact must degrade to the quiet "unavailable" placeholder (never a broken
 * render, never a leaked title/code). `resolveEmbedForReader` masks an absent
 * object identically to a hidden one — deleting an artifact that other documents
 * embed is safe by design (the resolver + the content_embed_links CASCADE handle it).
 */

const queryResults: Array<Array<Record<string, unknown>>> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => queryResults.shift() ?? []),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {
    id: "id",
    kind: "kind",
    ownerUserId: "ownerUserId",
    visibilityLevel: "visibilityLevel",
    title: "title",
    slug: "slug",
  },
  contentPublications: {
    objectId: "objectId",
    destination: "destination",
    status: "status",
    publishedVersionId: "publishedVersionId",
  },
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const canViewMock = jest.fn(async (..._a: unknown[]) => true);
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: (...a: unknown[]) => canViewMock(...a) },
}));
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: jest.fn(async () => ({ versionNumber: 1 })),
    getById: jest.fn(async () => ({ versionNumber: 1 })),
    loadArtifactCode: jest.fn(async () => "<html>live</html>"),
  },
}));
jest.mock("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxRenderUrl: () => "https://sandbox.example/render",
}));
jest.mock("@/lib/content/embed-directive", () => ({ isArtifactId: () => true }));
jest.mock("@/lib/content/render/document-parts", () => ({
  renderDocumentToParts: () => [],
}));

import { resolveEmbedForReader } from "@/lib/content/embed-resolver";
import type { Requester } from "@/lib/content/types";

const requester: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const ART_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  queryResults.length = 0;
  canViewMock.mockClear();
  canViewMock.mockResolvedValue(true);
});

describe("resolveEmbedForReader: deleted artifact degrades gracefully", () => {
  it("returns an UNAVAILABLE placeholder (no title/href/code) for a deleted artifact id", async () => {
    queryResults.push([]); // the artifact row is gone (hard-deleted)
    const embed = await resolveEmbedForReader(ART_ID, {
      audience: "internal",
      requester,
    });
    expect(embed).toEqual({
      artifactId: ART_ID,
      available: false,
      title: null,
      href: null,
      code: "",
      sandboxSrc: null,
    });
    // Never even consults visibility for an absent object.
    expect(canViewMock).not.toHaveBeenCalled();
  });

  it("still renders a live, viewable artifact (positive control — mask is delete-specific)", async () => {
    queryResults.push([
      {
        id: ART_ID,
        kind: "artifact",
        ownerUserId: 7,
        visibilityLevel: "internal",
        title: "Live Chart",
        slug: "live-chart",
      },
    ]);
    const embed = await resolveEmbedForReader(ART_ID, {
      audience: "internal",
      requester,
    });
    expect(embed.available).toBe(true);
    expect(embed.title).toBe("Live Chart");
    expect(embed.code).toBe("<html>live</html>");
  });
});
