/**
 * Regression tests for the §26.4 public-visibility gate on the CREATE and
 * SET_VISIBILITY write paths (Issue #1055, Phase 5 — PR #1088 review finding).
 *
 * The public-publish approval gate must not be bypassable through side doors:
 * before this fix it was enforced ONLY in `publishService.publish`, so an
 * under-scoped caller could reach `visibility.level = "public"` directly via
 * `contentService.create` (scope `content:create`) or `visibilityService.setLevel`
 * (scope `content:update`), making content public with no `ApprovalRequiredError`,
 * no approval-queue event, and no admin review.
 *
 * These tests prove the gate now fires on BOTH paths for callers WITHOUT
 * `content:publish_public`, and that authorized callers (admin / explicit
 * capability / delegated-with-grant) still pass. The gate runs BEFORE any DB
 * write, so the DB layer is mocked to fail loudly if it is reached on a rejected
 * request (asserting "nothing was written").
 */

// --- mocks (hoisted above imports by jest) ---

let executeTransactionCalls = 0;
let executeQueryCalls = 0;
// A queue of canned executeQuery results (e.g. the collection-default lookup);
// each call shifts the next, falling back to [] — lets a test drive
// `collectionDefaultOutsideTx` to a specific default_visibility_level.
let executeQueryResults: unknown[] = [];

// A chainable tx proxy: awaited terminals `.limit()` / `.returning()` yield the
// next queued result; every other builder method keeps the chain fluent. This
// lets an ALLOWED (gate-passing) setLevel run its FOR UPDATE lookup + UPDATE
// against a deterministic in-memory result instead of a real DB.
let txResults: unknown[] = [];
const txChain: Record<string, unknown> = {};
const txProxy: unknown = new Proxy(txChain, {
  get(_t, prop: string | symbol) {
    if (prop === "then") return undefined;
    if (prop === "returning" || prop === "limit") {
      return () => (txResults.length ? txResults.shift() : []);
    }
    return () => txProxy;
  },
});

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: jest.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      executeTransactionCalls += 1;
      // A rejected public request must never reach the write transaction. If it
      // does, this call increments the counter the tests assert stays 0.
      return cb(txProxy);
    }
  ),
  executeQuery: jest.fn(async () => {
    executeQueryCalls += 1;
    return executeQueryResults.length ? executeQueryResults.shift() : [];
  }),
}));

// The visibility UPDATE helper is exercised by its own suite; here we only care
// that setLevel reaches it (gate passed), so stub the mappers to a no-op.
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (r: unknown) => r,
}));

// content-service imports version-service, which transitively pulls the ESM-only
// markdown-render stack (unified/rehype-katex) that jest (SWC) cannot transform in
// node_modules. Mock it: the create gate runs BEFORE any version snapshot, so the
// real snapshot code is irrelevant to these gate tests. (Same pattern as
// tests/unit/atrium-create-version.test.ts.)
jest.mock("@/lib/content/version-service", () => ({
  versionService: {},
  snapshotInTx: jest.fn(async () => ({ id: "v1", versionNumber: 1 })),
}));

// Keep the events module a no-op but observable: the gate emits
// `content.public_publish_requested` on rejection (approval-queue signal).
let emitCalls: Array<{ type: string; payload: unknown }> = [];
jest.mock("@/lib/content/events", () => ({
  contentEvents: {
    emit: jest.fn(async (type: string, payload: unknown) => {
      emitCalls.push({ type, payload });
    }),
  },
}));

import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { ApprovalRequiredError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

// A non-admin staff user WITHOUT the publish_public capability.
const staffUser: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const adminUser: Requester = {
  kind: "user",
  userId: 1,
  roles: ["administrator"],
  isAdmin: true,
};
// An autonomous agent can NEVER publish public (no user, role-driven).
const autonomousAgent: Requester = {
  kind: "agent-autonomous",
  agentId: "agent-10",
  agentLabel: "seed-bot",
  roles: ["staff"],
  scopes: ["content:create", "content:update"],
};
// A delegated agent WITHOUT the publish_public grant.
const delegatedNoGrant: Requester = {
  kind: "agent-delegated",
  actingForUserId: 7,
  agentLabel: "assistant",
  roles: ["staff"],
  scopes: ["content:create", "content:update"],
};
// A delegated agent WITH the publish_public grant.
const delegatedWithGrant: Requester = {
  kind: "agent-delegated",
  actingForUserId: 7,
  agentLabel: "assistant",
  roles: ["staff"],
  scopes: ["content:create", "content:update", "content:publish_public"],
};

beforeEach(() => {
  executeTransactionCalls = 0;
  executeQueryCalls = 0;
  emitCalls = [];
  txResults = [];
  executeQueryResults = [];
  jest.clearAllMocks();
});

describe("§26.4 gate — contentService.create with visibility.level = 'public'", () => {
  const publicDoc = {
    kind: "document" as const,
    title: "Public doc",
    visibility: { level: "public" as const },
  };

  it("REJECTS a non-admin user without publish_public (ApprovalRequiredError, no write)", async () => {
    await expect(contentService.create(staffUser, publicDoc)).rejects.toThrow(
      ApprovalRequiredError
    );
    expect(executeTransactionCalls).toBe(0); // nothing created
    expect(emitCalls.map((c) => c.type)).toContain(
      "content.public_publish_requested"
    );
  });

  it("REJECTS an autonomous agent (can never publish public)", async () => {
    await expect(
      contentService.create(autonomousAgent, publicDoc)
    ).rejects.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBe(0);
  });

  it("REJECTS a delegated agent lacking the publish_public grant", async () => {
    await expect(
      contentService.create(delegatedNoGrant, publicDoc)
    ).rejects.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBe(0);
  });

  it("REJECTS a user even WITH the wildcard-derived flag left false (session must pass explicit capability)", async () => {
    // The surfaces derive `hasPublishPublicCapability` from the EXPLICIT scope, so
    // omitting it (default false) must reject — proving the wildcard cannot leak in.
    await expect(
      contentService.create(staffUser, publicDoc, {})
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it("ALLOWS an admin past the gate (proceeds to the write path)", async () => {
    // The gate passes for an admin; the write then runs (and fails in the mocked
    // slug/collection resolution, which is fine — we only assert the gate did not
    // short-circuit with ApprovalRequiredError).
    await expect(
      contentService.create(adminUser, publicDoc)
    ).rejects.not.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBeGreaterThan(0);
  });

  it("ALLOWS a user WITH the explicit publish_public capability", async () => {
    await expect(
      contentService.create(staffUser, publicDoc, {
        hasPublishPublicCapability: true,
      })
    ).rejects.not.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBeGreaterThan(0);
  });

  it("ALLOWS a delegated agent WITH the publish_public grant", async () => {
    await expect(
      contentService.create(delegatedWithGrant, publicDoc)
    ).rejects.not.toThrow(ApprovalRequiredError);
  });

  it("REJECTS + emits the approval event when a COLLECTION DEFAULT resolves to public (Gate 2, no explicit visibility)", async () => {
    // The seeded `public-site` collection has default_visibility_level = 'public',
    // so a create into it with NO explicit visibility resolves to "public" via the
    // collection default (Gate 2) rather than the explicit path (Gate 1). Both
    // gates must behave identically: fail closed AND emit the approval-queue signal
    // (regression for the Gate-2 path that previously threw WITHOUT emitting).
    executeQueryResults = [[{ level: "public" }]]; // collection-default lookup -> public
    await expect(
      contentService.create(staffUser, {
        kind: "document",
        title: "Doc into the public-site collection",
        collectionId: "col-public-site",
      })
    ).rejects.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBe(0); // nothing created
    expect(emitCalls.map((c) => c.type)).toContain(
      "content.public_publish_requested"
    );
  });

  it("does NOT gate a non-public create (internal level passes the gate)", async () => {
    await expect(
      contentService.create(staffUser, {
        kind: "document",
        title: "Internal doc",
        visibility: { level: "internal" },
      })
    ).rejects.not.toThrow(ApprovalRequiredError);
    expect(
      emitCalls.some((c) => c.type === "content.public_publish_requested")
    ).toBe(false);
  });
});

describe("§26.4 gate — visibilityService.setLevel to 'public'", () => {
  it("REJECTS a non-admin user without publish_public (ApprovalRequiredError, no write)", async () => {
    await expect(
      visibilityService.setLevel(staffUser, "o1", { level: "public" })
    ).rejects.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBe(0); // level unchanged
    expect(emitCalls.map((c) => c.type)).toContain(
      "content.public_publish_requested"
    );
  });

  it("REJECTS an autonomous agent widening to public", async () => {
    await expect(
      visibilityService.setLevel(autonomousAgent, "o1", { level: "public" })
    ).rejects.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBe(0);
  });

  it("REJECTS a delegated agent lacking the publish_public grant", async () => {
    await expect(
      visibilityService.setLevel(delegatedNoGrant, "o1", { level: "public" })
    ).rejects.toThrow(ApprovalRequiredError);
    expect(executeTransactionCalls).toBe(0);
  });

  it("ALLOWS an admin to widen to public (proceeds to the write path)", async () => {
    // Admin passes the gate; the write runs against the mocked tx (row present).
    txResults = [[{ id: "o1" }]]; // FOR UPDATE lock finds the row
    await expect(
      visibilityService.setLevel(adminUser, "o1", { level: "public" })
    ).resolves.toEqual({ visibilityLevel: "public" });
    expect(executeTransactionCalls).toBeGreaterThan(0);
    // The gate did NOT emit an approval request for an authorized caller.
    expect(
      emitCalls.some((c) => c.type === "content.public_publish_requested")
    ).toBe(false);
  });

  it("ALLOWS a user WITH the explicit publish_public capability", async () => {
    txResults = [[{ id: "o1" }]];
    await expect(
      visibilityService.setLevel(
        staffUser,
        "o1",
        { level: "public" },
        { hasPublishPublicCapability: true }
      )
    ).resolves.toEqual({ visibilityLevel: "public" });
  });

  it("does NOT gate a non-public setLevel (group/internal pass the gate)", async () => {
    txResults = [[{ id: "o1" }]];
    await expect(
      visibilityService.setLevel(staffUser, "o1", { level: "internal" })
    ).resolves.toEqual({ visibilityLevel: "internal" });
    expect(
      emitCalls.some((c) => c.type === "content.public_publish_requested")
    ).toBe(false);
  });
});
