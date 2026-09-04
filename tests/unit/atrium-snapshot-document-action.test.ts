/**
 * Unit tests for snapshotDocumentAction (Issue #1053, Atrium Phase 3).
 *
 * The action enforces per-object authorization in two distinct layers before
 * snapshotting a document body:
 *  - canView FIRST → a non-viewable object 404s (mask existence: never reveal
 *    via a 403 that this UUID exists). Matches setVisibilityAction,
 *    getVisibilityAction, and publishService.publish (§12.4).
 *  - canEdit SECOND → a viewer who cannot edit gets a 403 (ForbiddenError).
 *
 * These tests assert that control flow with all collaborators mocked:
 *  - a missing object → error ActionState, snapshot NEVER called
 *  - a non-viewable object → error ActionState (NOT ForbiddenError), snapshot
 *    NEVER called
 *  - a viewer who cannot edit → error ActionState, snapshot NEVER called
 *  - a valid owner edit → snapshot called with the resolved UUID + markdown body
 *
 * Plus (#1714) the base64 transit encoding: a document body containing literal
 * <script>/<style> is blocked at the edge WAF when posted raw, so the editor
 * sends it base64-encoded and this action decodes it BEFORE the service screens
 * and size-caps it. `decodeContentBody` is deliberately NOT mocked, so these
 * exercise the real validation.
 */

type LoadedObj = {
  id: string;
  ownerUserId: number;
  visibilityLevel: string;
} | null;
const loadByIdOrSlugMock = jest.fn(
  async (..._a: unknown[]): Promise<LoadedObj> => null
);
const canViewMock = jest.fn(async (..._a: unknown[]) => true);
const snapshotMock = jest.fn(async (..._a: unknown[]) => ({
  id: "version-1",
  versionNumber: 1,
}));
const canEditMock = jest.fn((..._a: unknown[]) => true);

jest.mock("@/lib/content", () => ({
  versionService: {
    snapshot: (...a: unknown[]) => snapshotMock(...a),
  },
}));

jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...a),
  },
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: (...a: unknown[]) => canViewMock(...a),
  },
}));

jest.mock("@/lib/content/helpers", () => ({
  canEdit: (...a: unknown[]) => canEditMock(...a),
}));

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub-1" })),
}));

jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: jest.fn(async () => ({
    kind: "user",
    userId: 7,
    roles: ["staff"],
    isAdmin: false,
  })),
}));

import { snapshotDocumentAction } from "@/actions/db/atrium/snapshot-document";

const OBJ = { id: "uuid-1", ownerUserId: 7, visibilityLevel: "private" };
const INPUT = { body: "# Hello", summary: "first save" };

beforeEach(() => {
  loadByIdOrSlugMock.mockReset().mockResolvedValue(OBJ);
  canViewMock.mockReset().mockResolvedValue(true);
  snapshotMock
    .mockReset()
    .mockResolvedValue({ id: "version-1", versionNumber: 1 });
  canEditMock.mockReset().mockReturnValue(true);
});

describe("snapshotDocumentAction — enforcement", () => {
  it("404s a missing object and never snapshots", async () => {
    loadByIdOrSlugMock.mockResolvedValueOnce(null);
    const result = await snapshotDocumentAction("o1", INPUT);
    expect(result.isSuccess).toBe(false);
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("404s a non-viewable object (not 403) and never snapshots", async () => {
    canViewMock.mockResolvedValueOnce(false);
    // Edit would also fail, but canView is checked FIRST so existence is masked:
    // the result must be an error and must NOT have reached the edit gate / write.
    canEditMock.mockReturnValue(false);
    const result = await snapshotDocumentAction("o1", INPUT);
    expect(result.isSuccess).toBe(false);
    expect(snapshotMock).not.toHaveBeenCalled();
    // The edit gate must not run when the object is non-viewable — masking
    // existence means we short-circuit at canView.
    expect(canEditMock).not.toHaveBeenCalled();
  });

  it("rejects a viewer who cannot edit and never snapshots", async () => {
    canEditMock.mockReturnValue(false);
    const result = await snapshotDocumentAction("o1", INPUT);
    expect(result.isSuccess).toBe(false);
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});

describe("snapshotDocumentAction — write", () => {
  it("snapshots against the resolved UUID with a markdown body", async () => {
    const result = await snapshotDocumentAction("some-slug", INPUT);
    expect(result.isSuccess).toBe(true);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    // Second arg is the version target: the RESOLVED uuid + document kind.
    expect(snapshotMock.mock.calls[0][1]).toEqual({
      id: "uuid-1",
      kind: "document",
    });
    const payload = snapshotMock.mock.calls[0][2] as {
      body: string;
      bodyFormat: string;
      summary?: string;
    };
    expect(payload.body).toBe("# Hello");
    expect(payload.bodyFormat).toBe("markdown");
    expect(payload.summary).toBe("first save");
  });
});

/** The body the service received on the most recent snapshot call. */
function snapshotBody(): string {
  return (snapshotMock.mock.calls[0][2] as { body: string }).body;
}

describe("snapshotDocumentAction — base64 transit encoding (#1714)", () => {
  it("decodes a base64 body before the service sees it", async () => {
    // Real markdown carrying the exact markup the WAF matches on.
    const markdown = "# Runbook\n\n```html\n<style>.a{}</style>\n```";
    const result = await snapshotDocumentAction(
      "some-slug",
      { body: Buffer.from(markdown, "utf8").toString("base64") },
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(true);
    expect(snapshotBody()).toBe(markdown);
  });

  it("round-trips a multi-byte body", async () => {
    const markdown = "# 日本語 — émoji 🎉\n\n<style>.b{}</style>";
    const result = await snapshotDocumentAction(
      "some-slug",
      { body: Buffer.from(markdown, "utf8").toString("base64") },
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(true);
    expect(snapshotBody()).toBe(markdown);
  });

  it("passes the body through untouched when no encoding is declared", async () => {
    // The pre-existing contract: every caller that never opts in is unaffected,
    // including one whose raw markdown happens to look like base64.
    const result = await snapshotDocumentAction("some-slug", { body: "SGVsbG8=" });

    expect(result.isSuccess).toBe(true);
    expect(snapshotBody()).toBe("SGVsbG8=");
  });

  it("rejects an invalid base64 body and never calls the service", async () => {
    const result = await snapshotDocumentAction(
      "some-slug",
      { body: "not valid base64 !!" },
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(false);
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("decodes only AFTER the authorization gates", async () => {
    // Ordering matters: were the decode first, a malformed body would throw
    // before the object was ever loaded, making "bad base64" a distinct signal
    // from "not viewable" — and that difference is observable to a caller
    // probing whether a UUID exists. Both gates running first is the proof.
    canViewMock.mockResolvedValueOnce(false);
    const result = await snapshotDocumentAction(
      "some-slug",
      { body: "not valid base64 !!" },
      { codeEncoding: "base64" }
    );

    expect(result.isSuccess).toBe(false);
    expect(loadByIdOrSlugMock).toHaveBeenCalled();
    expect(canViewMock).toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});
