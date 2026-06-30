/**
 * Unit tests for setVisibilityAction (Issue #1053, Atrium Phase 3).
 *
 * The action validates the visibility `level` and each grant `kind` at runtime
 * (both arrive as plain `string`), enforces canView (mask existence) then
 * assertCanEdit, and persists via visibilityService.setLevel. These tests assert
 * the control flow with all collaborators mocked:
 *  - invalid level / grant kind → error ActionState, service NEVER called
 *  - a non-viewable object → NotFound-style error, setLevel NEVER called
 *  - a viewer who cannot edit → error, setLevel NEVER called
 *  - a valid owner edit → setLevel called with the resolved UUID + grants
 *  - a non-group level → the action forwards level + grants verbatim to the
 *    service (the service, not the action, decides their fate — it REJECTS
 *    non-empty grants for a non-group level; see atrium-visibility.test.ts)
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
const setLevelMock = jest.fn(async (..._a: unknown[]) => ({
  visibilityLevel: "group",
}));
const canEditMock = jest.fn((..._a: unknown[]) => true);

jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...a),
  },
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: (...a: unknown[]) => canViewMock(...a),
    setLevel: (...a: unknown[]) => setLevelMock(...a),
  },
}));

// assertCanEdit throws ForbiddenError when canEdit returns false — replicate
// that contract so the action's edit gate is exercised.
jest.mock("@/lib/content/helpers", () => ({
  assertCanEdit: (...a: unknown[]) => {
    if (!canEditMock(...a)) {
      throw new (jest.requireActual("@/lib/content/errors").ForbiddenError)(
        "Not permitted to edit this content"
      );
    }
  },
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

import { setVisibilityAction } from "@/actions/db/atrium/set-visibility";

const OBJ = { id: "uuid-1", ownerUserId: 7, visibilityLevel: "private" };

beforeEach(() => {
  loadByIdOrSlugMock.mockReset().mockResolvedValue(OBJ);
  canViewMock.mockReset().mockResolvedValue(true);
  setLevelMock.mockReset().mockResolvedValue({ visibilityLevel: "group" });
  canEditMock.mockReset().mockReturnValue(true);
});

describe("setVisibilityAction — input validation", () => {
  it("rejects an invalid level without calling the service", async () => {
    const result = await setVisibilityAction("o1", { level: "__nope__" });
    expect(result.isSuccess).toBe(false);
    expect(setLevelMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid grant kind without calling the service", async () => {
    const result = await setVisibilityAction("o1", {
      level: "group",
      grants: [{ kind: "__evil__", value: "x" }],
    });
    expect(result.isSuccess).toBe(false);
    expect(setLevelMock).not.toHaveBeenCalled();
  });
});

describe("setVisibilityAction — enforcement", () => {
  it("404s a non-viewable object and never writes", async () => {
    canViewMock.mockResolvedValueOnce(false);
    const result = await setVisibilityAction("o1", { level: "internal" });
    expect(result.isSuccess).toBe(false);
    expect(setLevelMock).not.toHaveBeenCalled();
  });

  it("404s a missing object and never writes", async () => {
    loadByIdOrSlugMock.mockResolvedValueOnce(null);
    const result = await setVisibilityAction("o1", { level: "internal" });
    expect(result.isSuccess).toBe(false);
    expect(setLevelMock).not.toHaveBeenCalled();
  });

  it("rejects a viewer who cannot edit and never writes", async () => {
    canEditMock.mockReturnValue(false);
    const result = await setVisibilityAction("o1", { level: "internal" });
    expect(result.isSuccess).toBe(false);
    expect(setLevelMock).not.toHaveBeenCalled();
  });
});

describe("setVisibilityAction — write", () => {
  it("writes a group level with grants against the resolved UUID", async () => {
    const result = await setVisibilityAction("some-slug", {
      level: "group",
      grants: [{ kind: "role", value: "staff" }],
    });
    expect(result.isSuccess).toBe(true);
    expect(setLevelMock).toHaveBeenCalledTimes(1);
    // First arg is the RESOLVED uuid (not the input slug).
    expect(setLevelMock.mock.calls[0][0]).toBe("uuid-1");
    const visibility = setLevelMock.mock.calls[0][1] as {
      level: string;
      grants: { kind: string; value: string }[];
    };
    expect(visibility.level).toBe("group");
    expect(visibility.grants).toEqual([{ kind: "role", value: "staff" }]);
  });

  it("forwards a non-group level + grants verbatim to the service", async () => {
    // The action forwards the level + any grants verbatim; the SERVICE
    // (setLevelInTx) is the single point that decides their fate — it REJECTS
    // non-empty grants for a non-group level (verified in
    // atrium-visibility.test.ts). The action must not second-guess that
    // layering — it just validates the level/kinds + delegates. Here the
    // service is mocked, so we only assert the forwarding contract: the level
    // and the grants reach setLevel unchanged.
    await setVisibilityAction("o1", {
      level: "internal",
      grants: [{ kind: "role", value: "staff" }],
    });
    expect(setLevelMock).toHaveBeenCalledTimes(1);
    const visibility = setLevelMock.mock.calls[0][1] as {
      level: string;
      grants: { kind: string; value: string }[];
    };
    expect(visibility.level).toBe("internal");
    expect(visibility.grants).toEqual([{ kind: "role", value: "staff" }]);
  });
});
