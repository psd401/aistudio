/**
 * Unit tests for updateContentAction (Epic #1059 completion).
 *
 * The action is the UI's metadata-patch surface (rename / tags / collection /
 * archive-restore) over `contentService.update`. These tests assert the
 * control flow the unit can own:
 *  - only provided fields reach the service (no `undefined` writes)
 *  - the widened `string` status is runtime-narrowed: draft/archived pass,
 *    "published" (a publish-flow-only transition) and garbage fail BEFORE the
 *    service is called
 *  - an empty patch is rejected without a service call
 *  - the capability gate blocks a non-holder before the service is called
 *
 * Collaborators (session, requester, capability check, content service) are
 * mocked so this stays a pure control-flow unit test, mirroring
 * atrium-publish-document-action.test.ts.
 */

const updateMock = jest.fn(async (..._args: unknown[]) => ({
  id: "obj-1",
  kind: "document",
  title: "Renamed",
  status: "draft",
  collectionId: null,
  tags: [],
}));

jest.mock("@/lib/content", () => ({
  contentService: { update: (...args: unknown[]) => updateMock(...args) },
}));

const hasCapabilityAccessMock = jest.fn(async (..._args: unknown[]) => true);
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) => hasCapabilityAccessMock(...args),
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

import { updateContentAction } from "@/actions/db/atrium/update-content";

beforeEach(() => {
  updateMock.mockClear();
  hasCapabilityAccessMock.mockClear();
  hasCapabilityAccessMock.mockResolvedValue(true);
});

describe("updateContentAction — patch construction", () => {
  it("forwards only the provided fields to the service", async () => {
    const result = await updateContentAction("obj-1", {
      title: "Renamed",
      tags: ["policy"],
    });
    expect(result.isSuccess).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const patch = updateMock.mock.calls[0][2] as Record<string, unknown>;
    expect(patch).toEqual({ title: "Renamed", tags: ["policy"] });
    // Omitted fields are ABSENT, not undefined — an `undefined` in the patch
    // would be a clearable-field silent-failure hazard downstream.
    expect("collectionId" in patch).toBe(false);
    expect("status" in patch).toBe(false);
  });

  it("forwards an explicit collection clear (null) distinctly from omission", async () => {
    const result = await updateContentAction("obj-1", { collectionId: null });
    expect(result.isSuccess).toBe(true);
    const patch = updateMock.mock.calls[0][2] as Record<string, unknown>;
    expect(patch).toEqual({ collectionId: null });
  });

  it("rejects an empty patch without calling the service", async () => {
    const result = await updateContentAction("obj-1", {});
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("updateContentAction — status runtime narrowing", () => {
  it.each(["draft", "archived"])(
    "accepts status %s and forwards it to the service",
    async (status) => {
      const result = await updateContentAction("obj-1", { status });
      expect(result.isSuccess).toBe(true);
      const patch = updateMock.mock.calls[0][2] as { status?: string };
      expect(patch.status).toBe(status);
    }
  );

  it("rejects status 'published' before the service (publish is a separate gated flow)", async () => {
    const result = await updateContentAction("obj-1", { status: "published" });
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects a garbage status before the service", async () => {
    const result = await updateContentAction("obj-1", { status: "__evil__" });
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("updateContentAction — cover + icon (slice F)", () => {
  it.each(["default", "sunrise", "forest", "violet", "dusk"])(
    "accepts the preset cover key %s and forwards it",
    async (coverGradient) => {
      const result = await updateContentAction("obj-1", { coverGradient });
      expect(result.isSuccess).toBe(true);
      const patch = updateMock.mock.calls[0][2] as { coverGradient?: string };
      expect(patch.coverGradient).toBe(coverGradient);
    }
  );

  it("forwards an explicit cover clear (null) distinctly from omission", async () => {
    const result = await updateContentAction("obj-1", { coverGradient: null });
    expect(result.isSuccess).toBe(true);
    const patch = updateMock.mock.calls[0][2] as Record<string, unknown>;
    expect(patch).toEqual({ coverGradient: null });
  });

  it("rejects a non-preset cover value before the service (no raw CSS/arbitrary keys)", async () => {
    const result = await updateContentAction("obj-1", {
      coverGradient: "linear-gradient(#000,#fff)",
    });
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("trims and forwards a valid emoji icon", async () => {
    const result = await updateContentAction("obj-1", { icon: "  🎉  " });
    expect(result.isSuccess).toBe(true);
    const patch = updateMock.mock.calls[0][2] as { icon?: string | null };
    expect(patch.icon).toBe("🎉");
  });

  it("coerces an empty/whitespace icon to a null clear", async () => {
    const result = await updateContentAction("obj-1", { icon: "   " });
    expect(result.isSuccess).toBe(true);
    const patch = updateMock.mock.calls[0][2] as Record<string, unknown>;
    expect(patch.icon).toBeNull();
  });

  it("rejects an over-long icon before the service (guards against stashing text)", async () => {
    const result = await updateContentAction("obj-1", {
      icon: "this is not a single emoji",
    });
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("updateContentAction — gates", () => {
  it("blocks a caller without the atrium-content capability before the service", async () => {
    hasCapabilityAccessMock.mockResolvedValue(false);
    const result = await updateContentAction("obj-1", { title: "X" });
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects a missing idOrSlug without calling the service", async () => {
    const result = await updateContentAction("", { title: "X" });
    expect(result.isSuccess).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
