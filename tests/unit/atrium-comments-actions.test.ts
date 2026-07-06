/**
 * Unit tests for the Atrium document comment actions (Epic #1059, §18.1):
 * listCommentThreadsAction / createCommentThreadAction / replyToCommentAction /
 * resolveCommentThreadAction (actions/db/atrium/comments.ts).
 *
 * Covers the authorization ladder and the thread mapping with all DB + service
 * collaborators mocked; DB queries are dispatched by their executeQuery label so
 * the drizzle callbacks never run and the schema imports stay real. The content
 * services (loadByIdOrSlug / canView) and the session/capability/requester
 * resolvers are mocked; the edit gate (`assertCanEdit`) and author-id resolver
 * (`authorUserIdOf`) use the REAL helpers so the gate is exercised, not stubbed.
 */

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

const loadByIdOrSlugMock = jest.fn();
jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...a),
  },
}));

const canViewMock = jest.fn();
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: (...a: unknown[]) => canViewMock(...a) },
}));

const hasCapabilityAccessMock = jest.fn();
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...a: unknown[]) => hasCapabilityAccessMock(...a),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub-1" })),
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
  createCommentThreadAction,
  listCommentThreadsAction,
  replyToCommentAction,
  resolveCommentThreadAction,
} from "@/actions/db/atrium/comments";

const THREAD_ID = "11111111-1111-1111-1111-111111111111";

const OWNER = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  building: null,
  department: null,
  gradeLevels: null,
  isAdmin: false,
};
const NON_EDITOR = {
  kind: "user",
  userId: 99,
  roles: ["staff"],
  building: null,
  department: null,
  gradeLevels: null,
  isAdmin: false,
};
// Owned by OWNER (userId 7) → real assertCanEdit(OWNER, 7) passes; NON_EDITOR fails.
const OBJ = { id: "obj-1", ownerUserId: 7, visibilityLevel: "private" };

function labelCalls(label: string): number {
  return executeQueryMock.mock.calls.filter((c) => c[1] === label).length;
}

beforeEach(() => {
  getUserRequesterMock.mockReset().mockResolvedValue(OWNER);
  loadByIdOrSlugMock.mockReset().mockResolvedValue(OBJ);
  canViewMock.mockReset().mockResolvedValue(true);
  hasCapabilityAccessMock.mockReset().mockResolvedValue(true);
  executeQueryMock.mockClear();
  queryResults.clear();
  // Writes return nothing the actions consume (they reload via loadThread).
  queryResults.set("atrium.comments.insertRoot", []);
  queryResults.set("atrium.comments.insertReply", []);
  // A freshly-inserted root thread, returned by the post-write reload.
  queryResults.set("atrium.comments.loadThread", [
    {
      id: "c-root",
      threadId: THREAD_ID,
      parentId: null,
      body: "root body",
      authorAgentId: null,
      authorLabel: null,
      resolved: false,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      userFirstName: "Ada",
      userLastName: "Lovelace",
      userEmail: "ada@psd401.net",
    },
  ]);
});

describe("createCommentThreadAction", () => {
  it("rejects a non-editor before inserting the root row", async () => {
    getUserRequesterMock.mockResolvedValue(NON_EDITOR);
    const result = await createCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      body: "looks off",
    });
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.comments.insertRoot")).toBe(0);
  });

  it("404-masks a non-viewable object before inserting", async () => {
    canViewMock.mockResolvedValue(false);
    const result = await createCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      body: "hi",
    });
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.comments.insertRoot")).toBe(0);
  });

  it("rejects an empty body without inserting", async () => {
    const result = await createCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      body: "   ",
    });
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.comments.insertRoot")).toBe(0);
  });

  it("inserts the root as the requester and returns the thread DTO", async () => {
    const result = await createCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      body: "please revise",
    });
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(labelCalls("atrium.comments.insertRoot")).toBe(1);
    expect(result.data.threadId).toBe(THREAD_ID);
    expect(result.data.resolved).toBe(false);
    expect(result.data.comments).toHaveLength(1);
    expect(result.data.comments[0]).toMatchObject({
      authorKind: "human",
      authorLabel: "Ada Lovelace",
    });
  });
});

describe("listCommentThreadsAction", () => {
  it("404-masks a non-viewable object before querying comments", async () => {
    canViewMock.mockResolvedValue(false);
    const result = await listCommentThreadsAction("obj-1");
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.comments.listThreads")).toBe(0);
  });

  it("groups rows by thread (root first) and maps authorKind + label fallbacks", async () => {
    queryResults.set("atrium.comments.listThreads", [
      // Thread A: human root + human reply (reply has no name → email fallback).
      {
        id: "c1",
        threadId: "TA",
        parentId: null,
        body: "root A",
        authorAgentId: null,
        authorLabel: null,
        resolved: false,
        createdAt: new Date("2026-07-01T10:00:00Z"),
        userFirstName: "Ada",
        userLastName: "Lovelace",
        userEmail: "ada@psd401.net",
      },
      {
        id: "c2",
        threadId: "TA",
        parentId: "c1",
        body: "reply A",
        authorAgentId: null,
        authorLabel: null,
        resolved: false,
        createdAt: new Date("2026-07-01T11:00:00Z"),
        userFirstName: null,
        userLastName: null,
        userEmail: "bob@psd401.net",
      },
      // Thread B: resolved, agent-authored root (label is the agent label).
      {
        id: "c3",
        threadId: "TB",
        parentId: null,
        body: "root B",
        authorAgentId: "ag-1",
        authorLabel: "ship-bot",
        resolved: true,
        createdAt: new Date("2026-07-01T12:00:00Z"),
        userFirstName: null,
        userLastName: null,
        userEmail: null,
      },
    ]);

    const result = await listCommentThreadsAction("obj-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toHaveLength(2);

    const [a, b] = result.data;
    expect(a.threadId).toBe("TA");
    expect(a.resolved).toBe(false);
    expect(a.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(a.comments[0]).toMatchObject({
      authorKind: "human",
      authorLabel: "Ada Lovelace",
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    // No name on the reply → falls back to the email.
    expect(a.comments[1].authorLabel).toBe("bob@psd401.net");

    expect(b.threadId).toBe("TB");
    expect(b.resolved).toBe(true);
    expect(b.comments[0]).toMatchObject({
      authorKind: "agent",
      authorLabel: "ship-bot",
    });
  });

  it("returns an empty list when the document has no comments", async () => {
    queryResults.set("atrium.comments.listThreads", []);
    const result = await listCommentThreadsAction("obj-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toEqual([]);
  });
});

describe("replyToCommentAction", () => {
  it("404s a reply to a thread that does not exist for this object", async () => {
    queryResults.set("atrium.comments.findRoot", []);
    const result = await replyToCommentAction("obj-1", {
      threadId: THREAD_ID,
      body: "agree",
    });
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.comments.insertReply")).toBe(0);
  });

  it("inserts a reply under the resolved root and returns the thread", async () => {
    queryResults.set("atrium.comments.findRoot", [{ id: "c-root" }]);
    const result = await replyToCommentAction("obj-1", {
      threadId: THREAD_ID,
      body: "agree",
    });
    expect(result.isSuccess).toBe(true);
    expect(labelCalls("atrium.comments.insertReply")).toBe(1);
  });
});

describe("resolveCommentThreadAction", () => {
  it("flips the resolved flag across the thread rows", async () => {
    queryResults.set("atrium.comments.resolveThread", [
      { id: "c-root" },
      { id: "c-reply" },
    ]);
    const result = await resolveCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      resolved: true,
    });
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toEqual({ threadId: THREAD_ID, resolved: true });
    expect(labelCalls("atrium.comments.resolveThread")).toBe(1);
  });

  it("404s when no rows match the thread", async () => {
    queryResults.set("atrium.comments.resolveThread", []);
    const result = await resolveCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      resolved: false,
    });
    expect(result.isSuccess).toBe(false);
  });

  it("rejects a non-editor before updating", async () => {
    getUserRequesterMock.mockResolvedValue(NON_EDITOR);
    const result = await resolveCommentThreadAction("obj-1", {
      threadId: THREAD_ID,
      resolved: true,
    });
    expect(result.isSuccess).toBe(false);
    expect(labelCalls("atrium.comments.resolveThread")).toBe(0);
  });
});
