/**
 * Unit tests for the #1336 allow-then-notify public-publish policy.
 *
 * Product decision (Hagel, 2026-07-25): any AUTHOR may publish publicly — no
 * admin approval gate — and every non-admin public exposure records an
 * admin-visible notification instead.
 *
 * Two things must hold, and both are easy to regress silently:
 *
 *  1. The in-app authoring actions pass `hasPublishPublicCapability: true` into
 *     the service's §26.4 gate. If that ever stops being passed, a non-admin's
 *     public publish goes back to landing in the approval queue with no signal
 *     — exactly the "make public does nothing visible" bug #1336 fixed.
 *  2. The notification is written for a NON-ADMIN and deliberately skipped for
 *     an admin (who always held the authority, so "an author bypassed the
 *     queue" is not a meaningful notice). It is best-effort: it must never
 *     throw, because the caller's mutation has already committed.
 *
 * The service itself is mocked — its §26.4 gate is covered by
 * atrium-publish-service.test.ts. What is asserted here is the SURFACE
 * contract: what the actions hand the service, and what they record afterwards.
 */

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub" })),
}));

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
}));

/**
 * The service/audit collaborators are mocked with `unknown[]` rest params so the
 * positional arguments the ACTIONS pass can be asserted directly — that call
 * shape is the contract under test.
 */
const publishMock = jest.fn(async (..._a: unknown[]) => ({
  publicationId: "pub-1",
  publishedVersionId: "v-1",
  readerUrl: "https://example.test/p/slug-1",
}));
const unpublishMock = jest.fn(async (..._a: unknown[]) => ({
  unpublished: true,
}));
jest.mock("@/lib/content/publish-service", () => ({
  publishService: {
    publish: (...a: unknown[]) => publishMock(...a),
    unpublish: (...a: unknown[]) => unpublishMock(...a),
  },
}));

const recordContentAuditMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("@/lib/content/audit", () => ({
  recordContentAudit: (...a: unknown[]) => recordContentAuditMock(...a),
}));

const createMock = jest.fn(async (..._a: unknown[]) => ({
  id: "obj-new",
  kind: "document",
  visibilityLevel: "public",
  version: null,
}));
jest.mock("@/lib/content", () => ({
  contentService: { create: (...a: unknown[]) => createMock(...a) },
}));

import { createContentAction } from "@/actions/db/atrium/create-content";
import { publishDocumentAction } from "@/actions/db/atrium/publish-document";
import { unpublishDocumentAction } from "@/actions/db/atrium/unpublish-document";
import { notifyPublicExposure } from "@/lib/atrium/public-publish-policy";
import type { Requester } from "@/lib/content/types";

const AUTHOR = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
} as unknown as Requester;

const ADMIN = {
  kind: "user",
  userId: 1,
  roles: ["administrator"],
  isAdmin: true,
} as unknown as Requester;

beforeEach(() => {
  jest.clearAllMocks();
  getUserRequesterMock.mockResolvedValue(AUTHOR);
});

describe("in-app publish grants public-publish authority (#1336)", () => {
  it("passes hasPublishPublicCapability:true to publishService.publish", async () => {
    const result = await publishDocumentAction("obj-1", {
      destination: "public_web",
    });

    expect(result.isSuccess).toBe(true);
    expect(publishMock).toHaveBeenCalledTimes(1);
    // 4th positional arg is the service's `opts` object.
    const opts = publishMock.mock.calls[0][3] as {
      hasPublishPublicCapability?: boolean;
    };
    expect(opts.hasPublishPublicCapability).toBe(true);
  });

  it("returns the reader URL so the surface can show a copyable link", async () => {
    const result = await publishDocumentAction("obj-1", {
      destination: "public_web",
    });
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.readerUrl).toBe("https://example.test/p/slug-1");
  });

  it("forwards the optional visibility widen the confirm dialog supplies", async () => {
    await publishDocumentAction("obj-1", {
      destination: "public_web",
      visibility: { level: "public" },
    });
    const input = publishMock.mock.calls[0][2] as {
      visibility?: { level: string };
    };
    expect(input.visibility?.level).toBe("public");
  });

  it("forwards `widenOnly` — dropping it silently restores assignment semantics", async () => {
    // Regression: the action rebuilds `visibility` field-by-field to run the
    // runtime validators, and an earlier revision omitted this one. The type
    // still declared it, the UI still sent it, and the whole server-side
    // narrowing guard was dead with nothing failing.
    await publishDocumentAction("obj-1", {
      destination: "intranet",
      visibility: { level: "internal", widenOnly: true },
    });
    const input = publishMock.mock.calls[0][2] as {
      visibility?: { widenOnly?: boolean };
    };
    expect(input.visibility?.widenOnly).toBe(true);
  });

  it("defaults `widenOnly` to false for a caller that omits it (REST/MCP semantics)", async () => {
    await publishDocumentAction("obj-1", {
      destination: "intranet",
      visibility: { level: "internal" },
    });
    const input = publishMock.mock.calls[0][2] as {
      visibility?: { widenOnly?: boolean };
    };
    expect(input.visibility?.widenOnly).toBe(false);
  });

  it("passes the same authority to unpublish, so an author can retract", async () => {
    await unpublishDocumentAction("obj-1", { destination: "public_web" });
    expect(unpublishMock).toHaveBeenCalledTimes(1);
    const opts = unpublishMock.mock.calls[0][3] as {
      hasPublishPublicCapability?: boolean;
    };
    expect(opts.hasPublishPublicCapability).toBe(true);
  });
});

describe("in-app CREATE honours the same policy (#1336, Codex P2)", () => {
  it("passes hasPublishPublicCapability:true to contentService.create", async () => {
    await createContentAction({
      kind: "document",
      title: "t",
      visibility: { level: "public" },
    } as Parameters<typeof createContentAction>[0]);

    expect(createMock).toHaveBeenCalledTimes(1);
    // Without this, `resolveCreateVisibility`'s §26.4 "create-as-private"
    // downgrade fires and a non-admin creating explicitly-Public content
    // silently gets a PRIVATE object plus a queued widen request.
    const opts = createMock.mock.calls[0][2] as {
      hasPublishPublicCapability?: boolean;
    };
    expect(opts.hasPublishPublicCapability).toBe(true);
  });

  it("notifies when the created object actually RESOLVED to public", async () => {
    await createContentAction({
      kind: "document",
      title: "t",
      visibility: { level: "public" },
    } as Parameters<typeof createContentAction>[0]);

    expect(recordContentAuditMock).toHaveBeenCalledTimes(1);
    const entry = recordContentAuditMock.mock.calls[0][0] as {
      action: string;
      surface: string;
      objectId: string;
    };
    expect(entry.action).toBe("create");
    expect(entry.surface).toBe("ui");
    expect(entry.objectId).toBe("obj-new");
  });

  it("does NOT notify when the created object did not resolve to public", async () => {
    createMock.mockResolvedValueOnce({
      id: "obj-new",
      kind: "document",
      visibilityLevel: "private",
      version: null,
    });
    await createContentAction({
      kind: "document",
      title: "t",
    } as Parameters<typeof createContentAction>[0]);
    expect(recordContentAuditMock).not.toHaveBeenCalled();
  });
});

describe("allow-then-notify records an admin-visible notification (#1336)", () => {
  it("writes a public-exposure audit row for a NON-ADMIN public publish", async () => {
    await publishDocumentAction("obj-1", { destination: "public_web" });

    expect(recordContentAuditMock).toHaveBeenCalledTimes(1);
    const entry = recordContentAuditMock.mock.calls[0][0] as {
      action: string;
      surface: string;
      objectId: string;
      destination: string;
      outcome: string;
      details: { publicExposure?: boolean; note?: string };
    };
    expect(entry.action).toBe("publish");
    // `ui` is the in-app authoring surface — the /admin/atrium Audit tab filters
    // on it, so the wrong value here hides the notification.
    expect(entry.surface).toBe("ui");
    expect(entry.objectId).toBe("obj-1");
    expect(entry.destination).toBe("public_web");
    expect(entry.outcome).toBe("ok");
    expect(entry.details.publicExposure).toBe(true);
    expect(entry.details.note).toContain("public_web");
  });

  it("does NOT notify for an INTERNAL-only publish (no public exposure)", async () => {
    await publishDocumentAction("obj-1", { destination: "intranet" });
    expect(recordContentAuditMock).not.toHaveBeenCalled();
  });

  it("DOES notify when an intranet publish bundles a widen to public", async () => {
    await publishDocumentAction("obj-1", {
      destination: "intranet",
      visibility: { level: "public" },
    });
    expect(recordContentAuditMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT notify an ADMIN's public publish (they always held the authority)", async () => {
    getUserRequesterMock.mockResolvedValue(ADMIN);
    await publishDocumentAction("obj-1", { destination: "public_web" });
    expect(recordContentAuditMock).not.toHaveBeenCalled();
  });

  it("notifies on a non-admin public UNPUBLISH too", async () => {
    await unpublishDocumentAction("obj-1", { destination: "public_web" });
    expect(recordContentAuditMock).toHaveBeenCalledTimes(1);
    const entry = recordContentAuditMock.mock.calls[0][0] as { action: string };
    expect(entry.action).toBe("unpublish");
  });

  it("does NOT notify an unpublish that removed nothing", async () => {
    unpublishMock.mockResolvedValueOnce({ unpublished: false });
    await unpublishDocumentAction("obj-1", { destination: "public_web" });
    expect(recordContentAuditMock).not.toHaveBeenCalled();
  });

  it("is best-effort: a failing audit write does NOT reject", async () => {
    recordContentAuditMock.mockRejectedValueOnce(new Error("audit down"));
    // The notification runs AFTER the publish has already committed, so losing
    // the notice must never turn a successful mutation into a failed action.
    await expect(
      notifyPublicExposure({
        req: AUTHOR,
        action: "publish",
        objectId: "obj-1",
        destination: "public_web",
        note: "n",
      })
    ).resolves.toBeUndefined();
  });

  it("a failing audit write does not fail the publish action either", async () => {
    recordContentAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const result = await publishDocumentAction("obj-1", {
      destination: "public_web",
    });
    expect(result.isSuccess).toBe(true);
  });
});
