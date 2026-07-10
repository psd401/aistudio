/**
 * Unit tests for the version-history + rollback actions (Epic #1059 completion).
 *
 * `listContentVersionsAction` serves BOTH kinds (unlike the artifact-only
 * `listVersionsAction`) behind the same canView gate (`contentService.get`
 * 404-masks); `rollbackVersionAction` resolves a possible slug to the stable
 * UUID and delegates the permission work (canView 404-mask + assertCanEdit) to
 * `versionService.rollback`. These tests assert the action-layer control flow:
 *  - the document-kind version list maps to VersionSummary with the isCurrent
 *    marker and WITHOUT authorUserId (anti-enumeration)
 *  - a canView/NotFound failure surfaces as a failed ActionState
 *  - rollback targets the RESOLVED UUID (never the raw slug), and an absent
 *    object or missing capability blocks before the service is called
 */

const getMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  id: "obj-1",
  kind: "document",
  currentVersionId: "v2",
}));
const loadByIdOrSlugMock = jest.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    id: "obj-1",
    kind: "document",
  })
);
jest.mock("@/lib/content", () => ({
  contentService: {
    get: (...args: unknown[]) => getMock(...args),
    loadByIdOrSlug: (...args: unknown[]) => loadByIdOrSlugMock(...args),
  },
}));

const listMock = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [
  {
    id: "v2",
    objectId: "obj-1",
    versionNumber: 2,
    authorActor: "human",
    authorUserId: 7,
    summary: "human revision",
    createdAt: "2026-07-01T00:00:00Z",
  },
  {
    id: "v1",
    objectId: "obj-1",
    versionNumber: 1,
    authorActor: "agent",
    authorUserId: null,
    summary: null,
    createdAt: "2026-06-30T00:00:00Z",
  },
]);
const rollbackMock = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    list: (...args: unknown[]) => listMock(...args),
    rollback: (...args: unknown[]) => rollbackMock(...args),
  },
}));

const hasCapabilityAccessMock = jest.fn(async (..._args: unknown[]) => true);
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) => hasCapabilityAccessMock(...args),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub-1" })),
}));

const REQUESTER = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: jest.fn(async () => REQUESTER),
  getOptionalRequester: jest.fn(async () => REQUESTER),
}));

import {
  listContentVersionsAction,
  rollbackVersionAction,
} from "@/actions/db/atrium/rollback-version";
import { NotFoundError } from "@/lib/content/errors";

beforeEach(() => {
  getMock.mockClear();
  loadByIdOrSlugMock.mockClear();
  listMock.mockClear();
  rollbackMock.mockClear();
  hasCapabilityAccessMock.mockClear();
  hasCapabilityAccessMock.mockResolvedValue(true);
  getMock.mockResolvedValue({
    id: "obj-1",
    kind: "document",
    currentVersionId: "v2",
  });
  loadByIdOrSlugMock.mockResolvedValue({ id: "obj-1", kind: "document" });
});

describe("listContentVersionsAction — both kinds, canView-gated", () => {
  it("maps a DOCUMENT's versions to summaries with the isCurrent marker", async () => {
    const result = await listContentVersionsAction("obj-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({
      id: "v2",
      versionNumber: 2,
      authorActor: "human",
      summary: "human revision",
      createdAt: "2026-07-01T00:00:00Z",
      isCurrent: true,
    });
    expect(result.data[1].isCurrent).toBe(false);
    // authorUserId is a raw internal id — it must never reach the client
    // (anti-enumeration, same contract as listVersionsAction).
    expect("authorUserId" in result.data[0]).toBe(false);
  });

  it("surfaces a canView 404 (NotFound from contentService.get) as a failure", async () => {
    getMock.mockRejectedValue(new NotFoundError("Content not found", {}));
    const result = await listContentVersionsAction("obj-1");
    expect(result.isSuccess).toBe(false);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("rollbackVersionAction — gates + slug resolution", () => {
  it("rolls back via the RESOLVED UUID (never the raw slug) and returns the new head", async () => {
    const result = await rollbackVersionAction("some-slug", "v1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(rollbackMock).toHaveBeenCalledTimes(1);
    // (requester, objectId, toVersionId) — the resolved UUID, not the slug.
    expect(rollbackMock.mock.calls[0][1]).toBe("obj-1");
    expect(rollbackMock.mock.calls[0][2]).toBe("v1");
    expect(result.data).toEqual({ objectId: "obj-1", currentVersionId: "v1" });
  });

  it("fails for an absent object without calling the service", async () => {
    loadByIdOrSlugMock.mockResolvedValue(null);
    const result = await rollbackVersionAction("missing", "v1");
    expect(result.isSuccess).toBe(false);
    expect(rollbackMock).not.toHaveBeenCalled();
  });

  it("blocks a caller without the atrium-content capability before any lookup", async () => {
    hasCapabilityAccessMock.mockResolvedValue(false);
    const result = await rollbackVersionAction("obj-1", "v1");
    expect(result.isSuccess).toBe(false);
    expect(loadByIdOrSlugMock).not.toHaveBeenCalled();
    expect(rollbackMock).not.toHaveBeenCalled();
  });

  it("rejects missing inputs without calling the service", async () => {
    expect((await rollbackVersionAction("", "v1")).isSuccess).toBe(false);
    expect((await rollbackVersionAction("obj-1", "")).isSuccess).toBe(false);
    expect(rollbackMock).not.toHaveBeenCalled();
  });

  it("surfaces a service failure (e.g. version not in this object) as a failure", async () => {
    rollbackMock.mockRejectedValueOnce(new Error("Target version not found"));
    const result = await rollbackVersionAction("obj-1", "v-other");
    expect(result.isSuccess).toBe(false);
  });
});
