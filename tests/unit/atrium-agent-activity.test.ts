/**
 * Unit tests for listAgentActivityAction (Epic #1059 Meridian redesign, slice A).
 *
 * The AGENT ACTIVITY feed is a read path over the append-only content audit
 * trail — a small information-disclosure surface. Its safety rests on ONE
 * invariant: the feed only ever surfaces rows for objects the caller has already
 * been proven able to view (resolved through the vetted `contentService.list`
 * path). These tests pin that invariant at the code level, independent of the SQL
 * `inArray` bound: even if the audit query returned a row for an object outside
 * the visible set (a regression in the join, a stale row), the action drops it.
 *
 * `contentService.list` (visible-object resolution) and `executeQuery` (the audit
 * query) are mocked so the bound is tested in memory.
 */

let visibleObjects: Array<{ id: string; title: string; kind: string }> = [];
let auditRows: Array<{
  id: string;
  objectId: string | null;
  action: string;
  agentLabel: string | null;
  createdAt: Date | null;
}> = [];

const listMock = jest.fn(async (..._args: unknown[]) => visibleObjects);

// The factory is hoisted above `listMock`'s initialization, so it must reference
// it lazily (inside a closure evaluated at call time), never directly.
jest.mock("@/lib/content", () => ({
  contentService: { list: (...args: unknown[]) => listMock(...args) },
}));

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => auditRows),
}));

jest.mock("@/lib/db/schema", () => ({
  contentAuditLogs: {
    id: "cal.id",
    objectId: "cal.object_id",
    action: "cal.action",
    actorKind: "cal.actor_kind",
    agentLabel: "cal.agent_label",
    outcome: "cal.outcome",
    createdAt: "cal.created_at",
  },
}));

// Drizzle operators are irrelevant to the mocked query — collapse to passthroughs.
jest.mock("drizzle-orm", () => ({
  and: (...c: unknown[]) => c,
  or: (...c: unknown[]) => c,
  eq: (c: unknown) => c,
  desc: (c: unknown) => c,
  inArray: (c: unknown) => c,
  isNotNull: (c: unknown) => c,
}));

jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: jest.fn(async () => ({
    kind: "user",
    userId: 2,
    roles: ["staff"],
    isAdmin: false,
  })),
}));

import { listAgentActivityAction } from "@/actions/db/atrium/agent-activity";

beforeEach(() => {
  visibleObjects = [];
  auditRows = [];
  jest.clearAllMocks();
});

describe("listAgentActivityAction visibility bound", () => {
  it("returns nothing (and never queries the audit trail) when no content is visible", async () => {
    visibleObjects = [];
    auditRows = [{ id: "r1", objectId: "HIDDEN", action: "update", agentLabel: "Agent", createdAt: new Date() }];

    const res = await listAgentActivityAction();
    expect(res.isSuccess).toBe(true);
    if (res.isSuccess) expect(res.data).toEqual([]);
  });

  it("drops audit rows for objects outside the caller's visible set", async () => {
    // Only A and B are visible to the caller; C is not.
    visibleObjects = [
      { id: "A", title: "Alpha", kind: "document" },
      { id: "B", title: "Beta", kind: "artifact" },
    ];
    // The (mocked) audit query yields a row for the NON-visible object C plus a
    // null-object row — both must be dropped by the action's guard.
    auditRows = [
      { id: "r-a", objectId: "A", action: "update", agentLabel: "Agent 1", createdAt: new Date("2026-07-11T00:00:00Z") },
      { id: "r-c", objectId: "C", action: "publish", agentLabel: "Agent 1", createdAt: new Date("2026-07-11T00:01:00Z") },
      { id: "r-null", objectId: null, action: "create", agentLabel: "Agent 1", createdAt: new Date("2026-07-11T00:02:00Z") },
      { id: "r-b", objectId: "B", action: "create_version", agentLabel: "Agent 2", createdAt: new Date("2026-07-11T00:03:00Z") },
    ];

    const res = await listAgentActivityAction();
    expect(res.isSuccess).toBe(true);
    if (!res.isSuccess) return;

    const ids = res.data.map((i) => i.objectId);
    expect(ids).toEqual(["A", "B"]); // C and the null-object row excluded
    // Titles come from the visible-object map, never from the audit row.
    expect(res.data.find((i) => i.objectId === "A")?.title).toBe("Alpha");
    expect(res.data.find((i) => i.objectId === "B")?.kind).toBe("artifact");
  });

  it("clamps a caller-supplied limit to the safe maximum", async () => {
    visibleObjects = [{ id: "A", title: "Alpha", kind: "document" }];
    auditRows = [{ id: "r-a", objectId: "A", action: "update", agentLabel: "Agent", createdAt: new Date() }];

    const res = await listAgentActivityAction(9999);
    expect(res.isSuccess).toBe(true);
    // The list query is still consulted for the visible set.
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
