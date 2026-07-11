/**
 * Unit tests for `resolveEmbedForReader` masking (Epic #1059 Meridian slice D).
 *
 * The security contract (embed-resolver.ts §"Visibility rule"): the resolved shape
 * for an embed the viewer may NOT see must be BYTE-IDENTICAL whether the artifact is
 * absent, is not an artifact, or exists-but-is-hidden — the 404-style existence mask
 * — so a viewer can never distinguish a private artifact from an absent one through a
 * document that embeds it, and NO title/href/code is ever loaded for it. This holds
 * for BOTH audiences: `internal` (session + canView gate) and `public` (public-only,
 * no session). These tests pin that mask, and prove a viewable artifact DOES resolve
 * (so the mask is not simply always returned).
 *
 * Only the IO boundaries are mocked (DB via executeQuery, the visibility gate, the
 * version/code loader, the sandbox-url + heavy document-parts renderer). The real
 * `isArtifactId` id-shape validation runs. Uses the GLOBAL `jest` (repo convention),
 * never an `@jest/globals` import.
 */

// --- mocks (hoisted above imports by jest) ---

let queuedRows: unknown[] = [];
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => queuedRows),
}));
jest.mock("@/lib/db/schema", () => ({ contentObjects: {} }));
jest.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }));

let canViewResult = false;
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: jest.fn(async () => canViewResult) },
}));

// A viewable artifact loads its current head code; default to a version + code so the
// positive-control test can assert a live render. Overridden per test where needed.
let currentVersion: unknown = { id: "v1" };
let artifactCode = "<h1>live</h1>";
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: jest.fn(async () => currentVersion),
    loadArtifactCode: jest.fn(async () => artifactCode),
  },
}));
jest.mock("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxRenderUrl: () => "https://sandbox.example",
}));
// document-parts pulls the heavy unified/rehype render pipeline (ESM, not needed for
// resolveEmbedForReader); stub it so the module loads cheaply under jest.
jest.mock("@/lib/content/render/document-parts", () => ({
  renderDocumentToParts: () => [],
}));

import { resolveEmbedForReader, type ResolvedEmbed } from "@/lib/content/embed-resolver";
import type { Requester } from "@/lib/content/types";

const ARTIFACT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const requester: Requester = { kind: "user", userId: 1, roles: ["staff"], isAdmin: false };

/** The one masked shape all "cannot see it" paths must return, verbatim. */
function expectedMask(id: string): ResolvedEmbed {
  return { artifactId: id, available: false, title: null, href: null, code: "", sandboxSrc: null };
}

beforeEach(() => {
  queuedRows = [];
  canViewResult = false;
  currentVersion = { id: "v1" };
  artifactCode = "<h1>live</h1>";
});

describe("resolveEmbedForReader masks non-viewable embeds identically", () => {
  // Each row-state models one "cannot see it" reason; the mask must be identical
  // across all of them AND across both audiences.
  const hiddenCases: Array<{ name: string; rows: unknown[] }> = [
    { name: "absent object", rows: [] },
    {
      name: "non-artifact object (a document)",
      rows: [
        {
          id: ARTIFACT_ID,
          kind: "document",
          ownerUserId: 9,
          visibilityLevel: "public",
          title: "secret doc",
          slug: "secret-doc",
        },
      ],
    },
    {
      name: "artifact the viewer may not see",
      rows: [
        {
          id: ARTIFACT_ID,
          kind: "artifact",
          ownerUserId: 9,
          visibilityLevel: "private",
          title: "secret artifact",
          slug: "secret-artifact",
        },
      ],
    },
  ];

  for (const audience of ["internal", "public"] as const) {
    describe(`audience=${audience}`, () => {
      for (const c of hiddenCases) {
        it(`masks: ${c.name}`, async () => {
          queuedRows = c.rows;
          canViewResult = false; // internal gate denies; public gate is visibility-only
          const res = await resolveEmbedForReader(ARTIFACT_ID, { audience, requester });
          expect(res).toEqual(expectedMask(ARTIFACT_ID));
        });
      }

      it("masks: a malformed (non-UUID) id without touching the DB", async () => {
        const res = await resolveEmbedForReader("not-a-uuid", { audience, requester });
        expect(res).toEqual(expectedMask("not-a-uuid"));
      });
    });
  }

  it("the masked shape is identical across every hidden reason and both audiences", async () => {
    const shapes: ResolvedEmbed[] = [];
    for (const audience of ["internal", "public"] as const) {
      for (const c of hiddenCases) {
        queuedRows = c.rows;
        canViewResult = false;
        shapes.push(await resolveEmbedForReader(ARTIFACT_ID, { audience, requester }));
      }
    }
    // Every result must deep-equal the first — no reason/audience leaks a distinct shape.
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });
});

describe("resolveEmbedForReader resolves a viewable artifact", () => {
  const artifactRow = {
    id: ARTIFACT_ID,
    kind: "artifact" as const,
    ownerUserId: 9,
    visibilityLevel: "public" as const,
    title: "Metrics",
    slug: "metrics",
  };

  it("internal: canView=true yields a live, code-bearing render", async () => {
    queuedRows = [artifactRow];
    canViewResult = true;
    const res = await resolveEmbedForReader(ARTIFACT_ID, { audience: "internal", requester });
    expect(res.available).toBe(true);
    expect(res.title).toBe("Metrics");
    expect(res.href).toBe("/c/metrics");
    expect(res.code).toBe("<h1>live</h1>");
    expect(res.sandboxSrc).toBe("https://sandbox.example");
  });

  it("public: a public artifact resolves with a /p/ href and consults NO session gate", async () => {
    queuedRows = [artifactRow];
    canViewResult = false; // must be irrelevant for public (visibility-only)
    const res = await resolveEmbedForReader(ARTIFACT_ID, { audience: "public" });
    expect(res.available).toBe(true);
    expect(res.href).toBe("/p/metrics");
  });

  it("degrades to an empty live preview (not a mask) when the body load fails", async () => {
    queuedRows = [artifactRow];
    canViewResult = true;
    currentVersion = { id: "v1" };
    // Simulate a best-effort code load failure: available stays true, code is "".
    const { versionService } = jest.requireMock("@/lib/content/version-service") as {
      versionService: { loadArtifactCode: jest.Mock };
    };
    versionService.loadArtifactCode.mockRejectedValueOnce(new Error("S3 down"));
    const res = await resolveEmbedForReader(ARTIFACT_ID, { audience: "internal", requester });
    expect(res.available).toBe(true);
    expect(res.code).toBe("");
  });
});
