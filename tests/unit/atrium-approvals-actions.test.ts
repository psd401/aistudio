/**
 * Unit tests for the Atrium §26.4 approval-queue admin actions
 * (Epic #1059 completion): listPendingApprovalsAction /
 * approvePublishRequestAction / denyPublishRequestAction (approvals.ts) and
 * listContentAuditAction (audit-log.ts).
 *
 * Covers: non-admin rejection on every action, approve REPLAYING exactly the
 * recorded context (publish with/without the bundled widen, visibility_widen,
 * export = decision-only), replay failure leaving the row pending (no status
 * write), deny note requirement, and the audit page mapping. All DB + service
 * collaborators are mocked; queries are dispatched by their executeQuery label.
 */

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

const publishMock = jest.fn();
const unpublishMock = jest.fn();
jest.mock("@/lib/content/publish-service", () => ({
  publishService: {
    publish: (...a: unknown[]) => publishMock(...a),
    unpublish: (...a: unknown[]) => unpublishMock(...a),
  },
}));

const setLevelMock = jest.fn();
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { setLevel: (...a: unknown[]) => setLevelMock(...a) },
}));

// Queries never execute their drizzle callback — the mock dispatches on the
// executeQuery label (2nd arg), so the schema/drizzle imports stay real.
type Row = Record<string, unknown>;
const queryResults = new Map<string, Row[] | (() => Row[])>();
const executeQueryMock = jest.fn(
  async (_cb: unknown, label?: string): Promise<Row[]> => {
    const entry = label ? queryResults.get(label) : undefined;
    if (entry === undefined) {
      throw new Error(`unexpected query label: ${label}`);
    }
    return typeof entry === "function" ? entry() : entry;
  }
);
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...a: unknown[]) =>
    executeQueryMock(...(a as Parameters<typeof executeQueryMock>)),
}));

import {
  approvePublishRequestAction,
  denyPublishRequestAction,
  listPendingApprovalsAction,
} from "@/actions/db/atrium/approvals";
import { listContentAuditAction } from "@/actions/db/atrium/audit-log";

const ADMIN = {
  kind: "user",
  userId: 1,
  roles: ["administrator"],
  isAdmin: true,
};
const NON_ADMIN = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };

const BASE_ROW: Row = {
  id: "req-1",
  objectId: "obj-1",
  requestKind: "publish",
  destination: "intranet",
  context: {
    destination: "intranet",
    slug: "s",
    visibility: { level: "public" },
  },
  requestedByUserId: 42,
  requestedByAgentId: null,
  requesterLabel: null,
  status: "pending",
  decidedByUserId: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
};

function labelCalls(label: string): number {
  return executeQueryMock.mock.calls.filter((c) => c[1] === label).length;
}

beforeEach(() => {
  getUserRequesterMock.mockReset().mockResolvedValue(ADMIN);
  publishMock.mockReset().mockResolvedValue({
    publicationId: "pub-1",
    publishedVersionId: "v-1",
  });
  unpublishMock.mockReset().mockResolvedValue({ unpublished: true });
  setLevelMock.mockReset().mockResolvedValue({ visibilityLevel: "public" });
  executeQueryMock.mockClear();
  queryResults.clear();
  queryResults.set("atrium.approvals.load", [{ ...BASE_ROW }]);
  // Claim-first: the atomic pending→approved compare-and-set. A non-empty result
  // means THIS caller won the claim; [] means it was decided concurrently.
  queryResults.set("atrium.approvals.claimApprove", [{ id: "req-1" }]);
  queryResults.set("atrium.approvals.revertClaimOnReplayFailure", []);
  queryResults.set("atrium.approvals.markDenied", [{ id: "req-1" }]);
});

describe("admin gating", () => {
  it.each([
    ["listPendingApprovalsAction", () => listPendingApprovalsAction()],
    [
      "approvePublishRequestAction",
      () => approvePublishRequestAction("req-1"),
    ],
    [
      "denyPublishRequestAction",
      () => denyPublishRequestAction("req-1", "no"),
    ],
    ["listContentAuditAction", () => listContentAuditAction({})],
  ])("%s rejects a non-admin before any query or replay", async (_name, run) => {
    getUserRequesterMock.mockResolvedValue(NON_ADMIN);
    const result = await run();
    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(setLevelMock).not.toHaveBeenCalled();
  });
});

describe("approvePublishRequestAction — replay", () => {
  it("replays a publish request with EXACTLY the recorded context (destination + widen)", async () => {
    const result = await approvePublishRequestAction("req-1", "looks good");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toEqual({ id: "req-1", replayed: true });
    // The replay runs AS the approving admin requester.
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(ADMIN, "obj-1", {
      destination: "intranet",
      visibility: { level: "public" },
    });
    expect(labelCalls("atrium.approvals.claimApprove")).toBe(1);
  });

  it("replays a public-destination publish WITHOUT inventing a visibility widen", async () => {
    queryResults.set("atrium.approvals.load", [
      {
        ...BASE_ROW,
        destination: "public_web",
        context: { destination: "public_web", slug: "s" },
      },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(true);
    expect(publishMock).toHaveBeenCalledWith(ADMIN, "obj-1", {
      destination: "public_web",
    });
  });

  it("PINS the recorded version on a publish replay (issue #1118 item 1)", async () => {
    queryResults.set("atrium.approvals.load", [
      {
        ...BASE_ROW,
        destination: "public_web",
        context: {
          destination: "public_web",
          slug: "s",
          versionId: "v-reviewed",
        },
      },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(true);
    // The admin publishes the REVIEWED version, not the (possibly newer) head.
    expect(publishMock).toHaveBeenCalledWith(ADMIN, "obj-1", {
      destination: "public_web",
      versionId: "v-reviewed",
    });
  });

  it("replays an unpublish request via publishService.unpublish (issue #1118 item 2)", async () => {
    queryResults.set("atrium.approvals.load", [
      {
        ...BASE_ROW,
        requestKind: "unpublish",
        destination: "public_web",
        context: { destination: "public_web" },
      },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.replayed).toBe(true);
    expect(unpublishMock).toHaveBeenCalledWith(ADMIN, "obj-1", "public_web");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("replays a visibility_widen via visibilityService.setLevel with the recorded level", async () => {
    queryResults.set("atrium.approvals.load", [
      {
        ...BASE_ROW,
        requestKind: "visibility_widen",
        destination: "public",
        context: { level: "public" },
      },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(true);
    expect(setLevelMock).toHaveBeenCalledWith(ADMIN, "obj-1", {
      level: "public",
    });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("marks an export request approved WITHOUT replaying anything", async () => {
    queryResults.set("atrium.approvals.load", [
      {
        ...BASE_ROW,
        objectId: null,
        requestKind: "export",
        destination: "okf",
        context: { collectionId: "col-9", audience: "public" },
      },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.replayed).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
    expect(setLevelMock).not.toHaveBeenCalled();
    expect(labelCalls("atrium.approvals.claimApprove")).toBe(1);
  });

  it("surfaces a replay failure and REVERTS the claim so the row stays actionable", async () => {
    publishMock.mockRejectedValue(new Error("adapter not available"));
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(false);
    // Claim-first: the row was claimed (1) then reverted to pending (1) when the
    // replay threw — never left stuck `approved` with nothing published.
    expect(labelCalls("atrium.approvals.claimApprove")).toBe(1);
    expect(labelCalls("atrium.approvals.revertClaimOnReplayFailure")).toBe(1);
  });

  it("aborts WITHOUT replaying when the row was decided concurrently (claim wins nothing)", async () => {
    // loadRequest still sees a stale `pending` row, but a concurrent deny/approve
    // already flipped it: the atomic claim returns zero rows, so we must abort
    // BEFORE the publish side effect — the fix for the deny-races-replay window.
    queryResults.set("atrium.approvals.claimApprove", []);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
    expect(setLevelMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed destination instead of casting it into the service", async () => {
    queryResults.set("atrium.approvals.load", [
      { ...BASE_ROW, destination: "nonsense", context: {} },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
    // The claim happened before the destination was validated in replay, so it is
    // reverted rather than never-written.
    expect(labelCalls("atrium.approvals.revertClaimOnReplayFailure")).toBe(1);
  });

  it("errors on an already-decided request without replaying", async () => {
    queryResults.set("atrium.approvals.load", [
      { ...BASE_ROW, status: "approved" },
    ]);
    const result = await approvePublishRequestAction("req-1");
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("errors when the request does not exist", async () => {
    queryResults.set("atrium.approvals.load", []);
    const result = await approvePublishRequestAction("missing");
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe("denyPublishRequestAction", () => {
  it("requires a non-empty note before touching the database", async () => {
    const result = await denyPublishRequestAction("req-1", "   ");
    expect(result.isSuccess).toBe(false);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it("records the denial without replaying anything", async () => {
    const result = await denyPublishRequestAction("req-1", "not appropriate");
    expect(result.isSuccess).toBe(true);
    expect(labelCalls("atrium.approvals.markDenied")).toBe(1);
    expect(publishMock).not.toHaveBeenCalled();
    expect(setLevelMock).not.toHaveBeenCalled();
  });

  it("errors on an already-decided request", async () => {
    queryResults.set("atrium.approvals.load", [
      { ...BASE_ROW, status: "denied" },
    ]);
    const result = await denyPublishRequestAction("req-1", "nope");
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.approvals.markDenied")).toBe(0);
  });
});

describe("listPendingApprovalsAction", () => {
  it("maps the joined queue rows into DTOs (ISO timestamps)", async () => {
    queryResults.set("atrium.approvals.listPending", [
      {
        id: "req-1",
        objectId: "obj-1",
        requestKind: "publish",
        destination: "public_web",
        context: { destination: "public_web" },
        requesterLabel: null,
        requestedByUserId: 42,
        createdAt: new Date("2026-07-01T12:00:00Z"),
        objectTitle: "Board Doc",
        objectSlug: "board-doc",
        requesterEmail: "teacher@psd401.net",
      },
    ]);
    const result = await listPendingApprovalsAction();
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toEqual([
      {
        id: "req-1",
        objectId: "obj-1",
        objectTitle: "Board Doc",
        objectSlug: "board-doc",
        requestKind: "publish",
        destination: "public_web",
        context: { destination: "public_web" },
        requesterLabel: null,
        requestedByUserId: 42,
        requesterEmail: "teacher@psd401.net",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    ]);
  });
});

describe("listContentAuditAction", () => {
  it("returns a mapped page with the total count", async () => {
    queryResults.set("atrium.audit.listPage", [
      {
        id: "a-1",
        objectId: "obj-1",
        action: "publish",
        surface: "mcp",
        actorKind: "agent",
        actorUserId: null,
        agentId: "ag-1",
        agentLabel: "ship-reporter",
        destination: "intranet",
        outcome: "ok",
        error: null,
        requestId: "r-1",
        createdAt: new Date("2026-07-02T08:00:00Z"),
      },
    ]);
    queryResults.set("atrium.audit.countPage", [{ count: 123 }]);
    const result = await listContentAuditAction({ page: 2, action: "publish" });
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.total).toBe(123);
    expect(result.data.page).toBe(2);
    expect(result.data.pageSize).toBe(50);
    expect(result.data.rows).toEqual([
      {
        id: "a-1",
        objectId: "obj-1",
        action: "publish",
        surface: "mcp",
        actorKind: "agent",
        actorUserId: null,
        agentLabel: "ship-reporter",
        destination: "intranet",
        outcome: "ok",
        error: null,
        requestId: "r-1",
        createdAt: "2026-07-02T08:00:00.000Z",
      },
    ]);
  });

  it("clamps a nonsense page number to 1", async () => {
    queryResults.set("atrium.audit.listPage", []);
    queryResults.set("atrium.audit.countPage", [{ count: 0 }]);
    const result = await listContentAuditAction({ page: -3 });
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.page).toBe(1);
  });
});
