/** @jest-environment node */

/**
 * #1791 finding 1: the conversation <-> workspace binding lived ONLY in the
 * `?workspace=` URL param, so reopening a conversation lost the panel (and with
 * it the model's workspace tools), and every route back from the editor started
 * a NEW chat that re-ran every table listing and schema probe.
 *
 * The security property these tests pin is the one that matters: every query is
 * scoped to the caller's own conversations IN THE PREDICATE. A conversation is
 * private to the person who had it, and none of this may become a way to learn
 * that a conversation id exists, or who else has worked on an artifact.
 */

/** Captured `where(...)` argument trees, one per query. */
let predicates: unknown[] = [];
/** Rows the next query resolves to. */
let rows: Array<Record<string, unknown>> = [];
let setValues: Record<string, unknown> | null = null;
let orderBys: unknown[] = [];

jest.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, value: unknown) => ({ op: "eq", col, value }),
  ne: (col: unknown, value: unknown) => ({ op: "ne", col, value }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
}));

jest.mock("@/lib/db/schema", () => ({
  nexusConversations: {
    id: "col:id",
    userId: "col:userId",
    workspaceObjectId: "col:workspaceObjectId",
    isArchived: "col:isArchived",
    lastMessageAt: "col:lastMessageAt",
    updatedAt: "col:updatedAt",
  },
}));

const dbStub = {
  select: () => ({
    from: () => ({
      where: (predicate: unknown) => {
        predicates.push(predicate);
        const terminal = {
          limit: async () => rows,
          orderBy: (order: unknown) => {
            orderBys.push(order);
            return { limit: async () => rows };
          },
        };
        return terminal;
      },
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      setValues = values;
      return {
        where: async (predicate: unknown) => {
          predicates.push(predicate);
          return [];
        },
      };
    },
  }),
};

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(
    async (run: (db: unknown) => Promise<unknown>) => run(dbStub)
  ),
}));

const warnMock = jest.fn();
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: warnMock,
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  bindConversationWorkspace,
  findLatestConversationForWorkspace,
  getConversationWorkspaceObjectId,
  workspaceIdForTurn,
} from "@/lib/nexus/workspace-conversation-binding";

/** Flatten a captured predicate tree into its leaf comparisons. */
function leaves(node: unknown): Array<{ op: string; col?: unknown; value?: unknown }> {
  if (!node || typeof node !== "object") return [];
  const n = node as { op: string; args?: unknown[]; col?: unknown; value?: unknown };
  if (n.args) return n.args.flatMap(leaves);
  return [{ op: n.op, col: n.col, value: n.value }];
}

/** Does the predicate scope this query to a specific user id? */
function scopedToUser(predicate: unknown, userId: number): boolean {
  return leaves(predicate).some(
    (l) => l.op === "eq" && l.col === "col:userId" && l.value === userId
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  predicates = [];
  orderBys = [];
  rows = [];
  setValues = null;
});

describe("bindConversationWorkspace", () => {
  it("scopes the UPDATE to the caller's own conversation", async () => {
    await bindConversationWorkspace({
      conversationId: "conv-1",
      userId: 7,
      workspaceObjectId: "obj-1",
    });

    // Ownership is part of the predicate, not a prior read: there is no window
    // in which another user's row could be matched.
    expect(scopedToUser(predicates[0], 7)).toBe(true);
    expect(setValues?.workspaceObjectId).toBe("obj-1");
  });

  it("only writes when the binding is absent or DIFFERENT (idempotent steady state)", async () => {
    await bindConversationWorkspace({
      conversationId: "conv-1",
      userId: 7,
      workspaceObjectId: "obj-1",
    });

    const ops = leaves(predicates[0]).map((l) => l.op);
    // `ne` alone would miss the NULL case (NULL <> x is NULL, not true), so
    // both must be present for a first binding to ever land.
    expect(ops).toContain("isNull");
    expect(ops).toContain("ne");
  });

  it("swallows a failure — a turn must not die because a binding did not record", async () => {
    const { executeQuery } = jest.requireMock("@/lib/db/drizzle-client") as {
      executeQuery: jest.Mock;
    };
    executeQuery.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      bindConversationWorkspace({
        conversationId: "conv-1",
        userId: 7,
        workspaceObjectId: "obj-1",
      })
    ).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
  });
});

describe("getConversationWorkspaceObjectId", () => {
  it("returns the bound object for the caller's own conversation", async () => {
    rows = [{ workspaceObjectId: "obj-1" }];
    await expect(
      getConversationWorkspaceObjectId({ conversationId: "conv-1", userId: 7 })
    ).resolves.toBe("obj-1");
    expect(scopedToUser(predicates[0], 7)).toBe(true);
  });

  it("returns null for an unbound conversation", async () => {
    rows = [{ workspaceObjectId: null }];
    await expect(
      getConversationWorkspaceObjectId({ conversationId: "conv-1", userId: 7 })
    ).resolves.toBeNull();
  });

  it("returns null — not an error — for a conversation that is not the caller's", async () => {
    // The user-scoped predicate matches nothing. A miss and a not-yours are
    // indistinguishable, so this cannot be used to probe for a conversation id.
    rows = [];
    await expect(
      getConversationWorkspaceObjectId({ conversationId: "someone-elses", userId: 7 })
    ).resolves.toBeNull();
  });
});

describe("findLatestConversationForWorkspace", () => {
  it("returns the caller's most recent conversation about the object", async () => {
    rows = [{ id: "conv-9" }];
    await expect(
      findLatestConversationForWorkspace({ workspaceObjectId: "obj-1", userId: 7 })
    ).resolves.toBe("conv-9");
    expect(scopedToUser(predicates[0], 7)).toBe(true);
  });

  it("orders by last activity — 'the chat I was just in'", async () => {
    rows = [{ id: "conv-9" }];
    await findLatestConversationForWorkspace({ workspaceObjectId: "obj-1", userId: 7 });
    expect(orderBys[0]).toEqual({ op: "desc", col: "col:lastMessageAt" });
  });

  it("excludes archived conversations", async () => {
    rows = [{ id: "conv-9" }];
    await findLatestConversationForWorkspace({ workspaceObjectId: "obj-1", userId: 7 });
    // Reopening something the person filed away would be a surprise.
    expect(leaves(predicates[0])).toContainEqual({
      op: "eq",
      col: "col:isArchived",
      value: false,
    });
  });

  it("returns null when the caller has never chatted about the object", async () => {
    rows = [];
    await expect(
      findLatestConversationForWorkspace({ workspaceObjectId: "obj-1", userId: 7 })
    ).resolves.toBeNull();
  });

  it("never matches another user's conversation about the same object", async () => {
    rows = [];
    await findLatestConversationForWorkspace({ workspaceObjectId: "obj-1", userId: 7 });
    // "Who else worked on this artifact" is not a question this may answer.
    expect(scopedToUser(predicates[0], 7)).toBe(true);
  });
});

describe("workspaceIdForTurn (a send while the panel is still restoring)", () => {
  const base = {
    requestedWorkspaceId: undefined,
    restoreBoundWorkspace: true,
    conversationId: "conv-1",
    userId: 7,
  };

  it("uses an explicit workspace without reading the binding", async () => {
    rows = [{ workspaceObjectId: "obj-bound" }];
    await expect(
      workspaceIdForTurn({ ...base, requestedWorkspaceId: "obj-open" })
    ).resolves.toBe("obj-open");
    expect(predicates).toHaveLength(0);
  });

  it("falls back to the caller's persisted binding while restoring", async () => {
    rows = [{ workspaceObjectId: "obj-bound" }];
    await expect(workspaceIdForTurn(base)).resolves.toBe("obj-bound");
    expect(scopedToUser(predicates[0], 7)).toBe(true);
  });

  it("never reads the binding unless the client says it is restoring (a closed panel stays closed)", async () => {
    rows = [{ workspaceObjectId: "obj-bound" }];
    await expect(
      workspaceIdForTurn({ ...base, restoreBoundWorkspace: false })
    ).resolves.toBeUndefined();
    expect(predicates).toHaveLength(0);
  });

  it("degrades to no workspace when the lookup fails", async () => {
    const { executeQuery } = jest.requireMock("@/lib/db/drizzle-client") as {
      executeQuery: jest.Mock;
    };
    executeQuery.mockRejectedValueOnce(new Error("connection reset"));
    await expect(workspaceIdForTurn(base)).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
  });
});
