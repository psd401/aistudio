/**
 * Unit tests for getVisibilityAction and listGrantOptionsAction
 * (Issue #1053, Atrium Phase 3).
 *
 * getVisibilityAction:
 *  - missing object → error (NotFound)
 *  - non-viewable object → error (masked 404, not the grants)
 *  - viewable owner → success with level, grants, canEdit=true
 *  - viewable non-owner → success with canEdit=false
 *
 * listGrantOptionsAction:
 *  - unauthenticated (no session) → error
 *  - authenticated but capability denied → error
 *  - happy path → success with role names array
 *
 * All DB + session + visibility collaborators are mocked.
 */

// ─── mocks for getVisibilityAction ─────────────────────────────────────────

type LoadedObj = {
  id: string;
  ownerUserId: number;
  visibilityLevel: string;
} | null;

const loadByIdOrSlugMock = jest.fn(async (..._a: unknown[]): Promise<LoadedObj> => null);
const canViewMock = jest.fn(async (..._a: unknown[]) => true);
const grantsForMock = jest.fn(async (..._a: unknown[]) => [
  { kind: "role", value: "staff" },
]);
const canEditMock = jest.fn((..._a: unknown[]) => true);

jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...a),
  },
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: (...a: unknown[]) => canViewMock(...a),
    grantsFor: (...a: unknown[]) => grantsForMock(...a),
  },
}));

jest.mock("@/lib/content/helpers", () => ({
  canEdit: (...a: unknown[]) => canEditMock(...a),
}));

// getOptionalRequester always resolves — it falls back to a guest, never throws.
jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: jest.fn(async () => ({
    kind: "user",
    userId: 7,
    roles: ["staff"],
    isAdmin: false,
  })),
  // listGrantOptionsAction resolves the requester (authoritative null/sub check)
  // before the capability check. Mirror the real helper: throw when the threaded
  // session is null / has no sub, otherwise resolve an authenticated user.
  getUserRequester: jest.fn(
    async (_requestId?: string, session?: { sub?: string } | null) => {
      if (!session?.sub) {
        throw new Error("No active session");
      }
      return { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
    }
  ),
}));

// ─── mocks for listGrantOptionsAction ──────────────────────────────────────

const executeQueryMock = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

jest.mock("@/lib/db/schema", () => ({
  roles: { name: "roles.name" },
}));

jest.mock("drizzle-orm", () => ({
  asc: (col: unknown) => col,
  eq: (...a: unknown[]) => a,
}));

const hasCapabilityAccessMock = jest.fn(async (..._a: unknown[]) => true);
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...a: unknown[]) => hasCapabilityAccessMock(...a),
}));

const getServerSessionMock = jest.fn(async (..._a: unknown[]): Promise<{ sub: string } | null> => ({ sub: "cognito-sub-1" }));
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => getServerSessionMock(),
}));

// listGrantOptionsAction also loads the synced group picker options (#1205). Mock
// the query helper so the action test stays isolated from the groups query internals
// (the roles query still runs through executeQueryMock).
const listActiveGroupsForPickerMock = jest.fn(async () => [
  { email: "hs-staff@psd401.net", name: "HS Staff" },
]);
jest.mock("@/lib/groups/queries", () => ({
  listActiveGroupsForPicker: () => listActiveGroupsForPickerMock(),
}));

// ─── imports (after all jest.mock hoisting) ────────────────────────────────

import { getVisibilityAction } from "@/actions/db/atrium/get-visibility";
import { listGrantOptionsAction } from "@/actions/db/atrium/list-grant-options";

// ─── shared fixture ────────────────────────────────────────────────────────

const OBJ = { id: "uuid-1", ownerUserId: 7, visibilityLevel: "group" };

// ═══════════════════════════════════════════════════════════════════════════
// getVisibilityAction
// ═══════════════════════════════════════════════════════════════════════════

describe("getVisibilityAction — enforcement", () => {
  beforeEach(() => {
    loadByIdOrSlugMock.mockReset().mockResolvedValue(OBJ);
    canViewMock.mockReset().mockResolvedValue(true);
    grantsForMock.mockReset().mockResolvedValue([{ kind: "role", value: "staff" }]);
    canEditMock.mockReset().mockReturnValue(true);
  });

  it("returns an error when the object does not exist", async () => {
    loadByIdOrSlugMock.mockResolvedValueOnce(null);
    const result = await getVisibilityAction("missing-slug");
    expect(result.isSuccess).toBe(false);
    // grantsFor must never be called — we can't enumerate grants for a missing object.
    expect(grantsForMock).not.toHaveBeenCalled();
  });

  it("masks existence when the requester cannot view the object", async () => {
    // A non-viewable object returns an error, NOT the grants — ensures private
    // object ids cannot be used to enumerate grant sets.
    canViewMock.mockResolvedValueOnce(false);
    const result = await getVisibilityAction("some-slug");
    expect(result.isSuccess).toBe(false);
    expect(grantsForMock).not.toHaveBeenCalled();
  });
});

describe("getVisibilityAction — success shape", () => {
  beforeEach(() => {
    loadByIdOrSlugMock.mockReset().mockResolvedValue(OBJ);
    canViewMock.mockReset().mockResolvedValue(true);
    grantsForMock.mockReset().mockResolvedValue([{ kind: "role", value: "staff" }]);
    canEditMock.mockReset().mockReturnValue(true);
    getServerSessionMock.mockReset().mockResolvedValue({ sub: "cognito-sub-1" });
    hasCapabilityAccessMock.mockReset().mockResolvedValue(true);
  });

  it("returns level, grants, and canEdit=true for the object owner", async () => {
    const result = await getVisibilityAction("uuid-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.visibilityLevel).toBe("group");
    expect(result.data.grants).toEqual([{ kind: "role", value: "staff" }]);
    expect(result.data.canEdit).toBe(true);
  });

  it("returns canEdit=false for an owner WITHOUT the atrium-content capability", async () => {
    // The edit gate must match setVisibilityAction's (owner/admin AND capability),
    // or the chip would show a Save button to a non-capable owner whose every save
    // then fails with an opaque authz error. canEdit (owner) is true here, but the
    // missing capability must zero out the editable flag.
    hasCapabilityAccessMock.mockResolvedValueOnce(false);
    const result = await getVisibilityAction("uuid-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.canEdit).toBe(false);
    // A non-editor must not receive the grant list.
    expect(result.data.grants).toEqual([]);
  });

  it("returns canEdit=false AND no grants for a non-owner who can only view", async () => {
    // Security: the grant list names every principal explicitly granted access
    // (including the numeric users.id of each `user` grant). A viewer who is not the
    // owner/admin must NOT be able to enumerate it — they only need the level for the
    // read-only badge. The action must return an empty grant list and never call
    // grantsFor for a non-editor.
    canEditMock.mockReturnValueOnce(false);
    const result = await getVisibilityAction("uuid-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.canEdit).toBe(false);
    expect(result.data.grants).toEqual([]);
    expect(grantsForMock).not.toHaveBeenCalled();
  });

  it("always loads grants, even for non-group levels (preserves prior selection in UI)", async () => {
    // The spec notes grants should be returned regardless of the current level so
    // the editor can restore the prior selection if the user toggles away from
    // `group` and back without saving.
    loadByIdOrSlugMock.mockResolvedValueOnce({ ...OBJ, visibilityLevel: "internal" });
    grantsForMock.mockResolvedValueOnce([{ kind: "role", value: "staff" }]);
    const result = await getVisibilityAction("uuid-1");
    expect(result.isSuccess).toBe(true);
    // grantsFor must have been called once.
    expect(grantsForMock).toHaveBeenCalledTimes(1);
    if (!result.isSuccess) return;
    expect(result.data.visibilityLevel).toBe("internal");
    // Grants returned even though level is not "group".
    expect(result.data.grants).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listGrantOptionsAction
// ═══════════════════════════════════════════════════════════════════════════

describe("listGrantOptionsAction — auth gates", () => {
  beforeEach(() => {
    getServerSessionMock.mockReset().mockResolvedValue({ sub: "cognito-sub-1" });
    hasCapabilityAccessMock.mockReset().mockResolvedValue(true);
    // Default: DB returns two roles.
    executeQueryMock.mockReset().mockImplementation((cb: (db: unknown) => unknown) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "from", "orderBy"]) {
        builder[m] = jest.fn(() => builder);
      }
      // Terminal: resolve with role rows.
      builder.orderBy = jest.fn(() =>
        Promise.resolve([{ name: "staff" }, { name: "teacher" }])
      );
      return cb(builder);
    });
  });

  it("returns error when there is no session", async () => {
    getServerSessionMock.mockResolvedValueOnce(null);
    const result = await listGrantOptionsAction();
    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("returns error when the session exists but sub is absent", async () => {
    getServerSessionMock.mockResolvedValueOnce({} as never);
    const result = await listGrantOptionsAction();
    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("returns error when the atrium-content capability is not granted", async () => {
    hasCapabilityAccessMock.mockResolvedValueOnce(false);
    const result = await listGrantOptionsAction();
    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("returns role names sorted by the DB on the happy path", async () => {
    const result = await listGrantOptionsAction();
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.roles).toEqual(["staff", "teacher"]);
  });

  it("returns the active synced groups for the group picker (#1205)", async () => {
    const result = await listGrantOptionsAction();
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.groups).toEqual([
      { email: "hs-staff@psd401.net", name: "HS Staff" },
    ]);
  });
});
