/**
 * Unit tests for the §26.4 approval-queue persistence (Epic #1059 completion):
 * `approvalRequestFieldsOf` (pure raise-site classification) and
 * `raisePublishApprovalRequired`'s best-effort `content_publish_requests` write.
 *
 * Covers: row written with correct identity fields for user / delegated /
 * autonomous requesters, kind/destination/context derivation per raise site,
 * the ON CONFLICT DO NOTHING dedupe mechanism, and the fail-open guarantee —
 * an insert failure log.warns but the gate still throws ApprovalRequiredError.
 */

// `marked` ships ESM-only and is excluded from Jest's transform; mock it (same
// as atrium-content-helpers.test.ts) so the content module graph loads.
jest.mock("marked", () => ({ marked: { parse: (md: string) => md } }));

const logMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => logMock),
  generateRequestId: jest.fn(() => "req-test"),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((value: unknown) => value),
}));

// Capture the insert chain: db.insert(table).values(v).onConflictDoNothing().
let capturedValues: Record<string, unknown> | null = null;
let onConflictCalls = 0;
const executeQueryMock = jest.fn(
  async (cb: (db: unknown) => unknown, _label?: string) => {
    const chain: Record<string, unknown> = {};
    chain.insert = jest.fn(() => chain);
    chain.values = jest.fn((v: Record<string, unknown>) => {
      capturedValues = v;
      return chain;
    });
    chain.onConflictDoNothing = jest.fn(() => {
      onConflictCalls++;
      return Promise.resolve([]);
    });
    return cb(chain);
  }
);
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) =>
    executeQueryMock(...(args as Parameters<typeof executeQueryMock>)),
}));

import {
  approvalRequestFieldsOf,
  persistPublishApprovalRequest,
  raisePublishApprovalRequired,
} from "@/lib/content/helpers";
import { ApprovalRequiredError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const userReq: Requester = {
  kind: "user",
  userId: 42,
  roles: ["staff"],
  isAdmin: false,
};
const delegatedReq: Requester = {
  kind: "agent-delegated",
  actingForUserId: 42,
  roles: ["staff"],
  scopes: ["content:update"],
  agentLabel: "my-agent",
};
const autonomousReq: Requester = {
  kind: "agent-autonomous",
  agentId: "11111111-1111-1111-1111-111111111111",
  roles: ["staff"],
  scopes: ["content:create"],
  agentLabel: "ship-reporter",
};

/** Let the fire-and-forget persist (started before the throw) settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  capturedValues = null;
  onConflictCalls = 0;
  executeQueryMock.mockClear();
  logMock.warn.mockClear();
});

describe("approvalRequestFieldsOf — raise-site classification", () => {
  it("classifies a public-destination publish gate as kind 'publish' (no invented widen)", () => {
    const fields = approvalRequestFieldsOf(
      { objectId: "o1", slug: "board-doc", destination: "public_web" },
      { destination: "public_web", objectId: "o1" }
    );
    expect(fields).toEqual({
      objectId: "o1",
      requestKind: "publish",
      destination: "public_web",
      // The pre-tx gate cannot see the caller's optional visibility input, so
      // none is recorded — replay publishes to the destination only.
      context: { destination: "public_web", slug: "board-doc" },
    });
  });

  it("classifies a non-public-destination gate as publish WITH the bundled widen", () => {
    // The in-tx gate is only reachable when the destination is NOT public (a
    // public one throws pre-tx first), so the gated part was the visibility
    // widen to public — recorded for replay.
    const fields = approvalRequestFieldsOf(
      { objectId: "o1", slug: "s", destination: "intranet" },
      { destination: "intranet", objectId: "o1" }
    );
    expect(fields.requestKind).toBe("publish");
    expect(fields.destination).toBe("intranet");
    expect(fields.context).toEqual({
      destination: "intranet",
      slug: "s",
      visibility: { level: "public" },
    });
  });

  it("treats a single-OBJECT okf publish (objectId present) as publish, not export", () => {
    const fields = approvalRequestFieldsOf(
      { objectId: "o1", destination: "okf" },
      { destination: "okf", objectId: "o1" }
    );
    expect(fields.requestKind).toBe("publish");
    expect(fields.objectId).toBe("o1");
    expect(fields.context.visibility).toEqual({ level: "public" });
  });

  it("classifies the destination-less setLevel gate as visibility_widen -> public", () => {
    const fields = approvalRequestFieldsOf({ objectId: "o1" }, { objectId: "o1" });
    expect(fields).toEqual({
      objectId: "o1",
      requestKind: "visibility_widen",
      destination: "public",
      context: { level: "public" },
    });
  });

  it("classifies the collection OKF exporter (okf + empty objectId) as an object-less export", () => {
    const fields = approvalRequestFieldsOf(
      { objectId: "", destination: "okf" },
      { collectionId: "col-9", audience: "public" }
    );
    expect(fields).toEqual({
      objectId: null,
      requestKind: "export",
      destination: "okf",
      context: { collectionId: "col-9", audience: "public" },
    });
  });
});

describe("raisePublishApprovalRequired — queue-row persistence", () => {
  it("throws SYNCHRONOUSLY and writes the row for a user requester", async () => {
    expect(() =>
      raisePublishApprovalRequired(
        userReq,
        "Publishing to a public destination requires approval",
        { objectId: "o1", slug: "s", destination: "public_web" },
        { destination: "public_web", objectId: "o1" }
      )
    ).toThrow(ApprovalRequiredError);
    await flush();
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    expect(capturedValues).toEqual({
      objectId: "o1",
      requestKind: "publish",
      destination: "public_web",
      context: { destination: "public_web", slug: "s" },
      requestedByUserId: 42,
      requestedByAgentId: null,
      requesterLabel: null,
    });
    // The dedupe mechanism: every insert goes through ON CONFLICT DO NOTHING
    // against the pending partial unique indexes (migration 096), so a repeat
    // of the same blocked request collapses into the one open row.
    expect(onConflictCalls).toBe(1);
  });

  it("records the autonomous agent identity (agent id + label, no user id)", async () => {
    expect(() =>
      raisePublishApprovalRequired(
        autonomousReq,
        "Widening visibility to public requires approval",
        { objectId: "o2" },
        { objectId: "o2" }
      )
    ).toThrow(ApprovalRequiredError);
    await flush();
    expect(capturedValues).toMatchObject({
      objectId: "o2",
      requestKind: "visibility_widen",
      destination: "public",
      requestedByUserId: null,
      requestedByAgentId: "11111111-1111-1111-1111-111111111111",
      requesterLabel: "ship-reporter",
    });
  });

  it("records a delegated agent as its human (user id) plus the agent label", async () => {
    expect(() =>
      raisePublishApprovalRequired(
        delegatedReq,
        "Publishing to a public destination requires approval",
        { objectId: "o3", destination: "schoology" },
        { destination: "schoology", objectId: "o3" }
      )
    ).toThrow(ApprovalRequiredError);
    await flush();
    expect(capturedValues).toMatchObject({
      requestedByUserId: 42,
      requestedByAgentId: null,
      requesterLabel: "my-agent",
    });
  });

  it("uses ON CONFLICT DO NOTHING on every repeat raise (DB-level dedupe)", async () => {
    for (let i = 0; i < 2; i++) {
      expect(() =>
        raisePublishApprovalRequired(
          userReq,
          "Publishing to a public destination requires approval",
          { objectId: "o1", destination: "public_web" },
          { destination: "public_web", objectId: "o1" }
        )
      ).toThrow(ApprovalRequiredError);
    }
    await flush();
    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(onConflictCalls).toBe(2);
  });

  it("still throws (and only log.warns) when the insert fails — the gate is never masked", async () => {
    executeQueryMock.mockRejectedValueOnce(new Error("db down"));
    expect(() =>
      raisePublishApprovalRequired(
        userReq,
        "Publishing to a public destination requires approval",
        { objectId: "o1", destination: "public_web" },
        { destination: "public_web", objectId: "o1" }
      )
    ).toThrow(ApprovalRequiredError);
    await flush();
    expect(logMock.warn).toHaveBeenCalledWith(
      "Failed to persist publish approval request",
      expect.objectContaining({ error: "db down" })
    );
  });
});

describe("persistPublishApprovalRequest — export rows", () => {
  it("writes an object-less export row keyed on the collection", async () => {
    await persistPublishApprovalRequest(
      userReq,
      { objectId: "", destination: "okf" },
      { collectionId: "col-9", audience: "public" }
    );
    expect(capturedValues).toMatchObject({
      objectId: null,
      requestKind: "export",
      destination: "okf",
      context: { collectionId: "col-9", audience: "public" },
      requestedByUserId: 42,
    });
  });

  it("never rejects on failure (best-effort contract)", async () => {
    executeQueryMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      persistPublishApprovalRequest(
        userReq,
        { objectId: "o1", destination: "public_web" },
        { destination: "public_web", objectId: "o1" }
      )
    ).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalled();
  });
});
