/**
 * §26.4 create-as-private (issue #1118 item 2).
 *
 * An unauthorized public CREATE is NO LONGER blocked with ApprovalRequiredError
 * (the old behaviour threw with NOTHING persisted, so the request never reached
 * /admin/atrium and the caller's content was lost). Instead
 * `contentService.create` downgrades the object to PRIVATE and queues a durable
 * `visibility_widen` request for it — replayed cleanly on approve.
 *
 * These tests drive a BODYLESS create all the way to success and assert:
 *   - an unauthorized caller's object is persisted at visibility 'private';
 *   - a `visibility_widen` approval row is queued for the new object id;
 *   - the approval-queue event is emitted;
 *   - an AUTHORIZED caller is NOT downgraded (persists 'public', queues nothing).
 */

jest.mock("marked", () => ({ marked: { parse: (md: string) => md } }));

// Captured by the DB-layer mocks below.
let insertedObjectValues: Record<string, unknown> | null = null;
let persistedApprovalValues: Record<string, unknown> | null = null;

// A minimal transaction stub that lets a bodyless create SUCCEED: uniqueSlug's
// collision lookup resolves to [] (no collisions → the base slug is free), and
// the object INSERT captures its values + returns a row.
const txStub = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      insertedObjectValues = v;
      return {
        returning: () =>
          Promise.resolve([{ id: "obj-new", slug: "public-doc", ...v }]),
      };
    },
  }),
};

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(txStub)
  ),
  // executeQuery backs persistPublishApprovalRequest's visibility_widen insert.
  executeQuery: jest.fn(async (cb: (db: unknown) => unknown) => {
    const chain: Record<string, unknown> = {};
    chain.insert = () => chain;
    chain.values = (v: Record<string, unknown>) => {
      persistedApprovalValues = v;
      return chain;
    };
    chain.onConflictDoNothing = () => Promise.resolve([]);
    return cb(chain);
  }),
}));

jest.mock("@/lib/db/schema", () => ({
  contentObjects: {},
  contentCollections: {},
  contentPublishRequests: {},
}));
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (v: unknown) => JSON.stringify(v),
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  like: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));

jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
// The create gate runs BEFORE any version snapshot; a bodyless create never
// snapshots, so stub the version service (also avoids the ESM markdown stack).
jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: { flushSnapshotWrites: jest.fn(async () => undefined) },
}));
// Visibility invariants pass; grant reconciliation is a no-op here.
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    assertWritableLevel: jest.fn(),
    applyGrantsForLevel: jest.fn(async () => undefined),
  },
}));
// Observe the approval-queue event the widen queue emits.
let emitCalls: Array<{ type: string; payload: unknown }> = [];
jest.mock("@/lib/content/events", () => ({
  contentEvents: {
    emit: jest.fn(async (type: string, payload: unknown) => {
      emitCalls.push({ type, payload });
    }),
  },
}));

import { contentService } from "@/lib/content/content-service";
import type { Requester } from "@/lib/content/types";

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

const publicDoc = {
  kind: "document" as const,
  title: "Public doc",
  visibility: { level: "public" as const },
};

beforeEach(() => {
  insertedObjectValues = null;
  persistedApprovalValues = null;
  emitCalls = [];
  jest.clearAllMocks();
});

describe("contentService.create — create-as-private for an unauthorized public create", () => {
  it("persists the object as PRIVATE (never public) and queues a visibility_widen", async () => {
    const result = await contentService.create(staffUser, publicDoc);

    // The created object is private, not the requested public.
    expect(insertedObjectValues?.visibilityLevel).toBe("private");
    expect(result.visibilityLevel).toBe("private");

    // A durable visibility_widen request was queued for the new object.
    expect(persistedApprovalValues).toMatchObject({
      objectId: "obj-new",
      requestKind: "visibility_widen",
      destination: "public",
      requestedByUserId: 7,
    });

    // The approval-queue event was emitted (SNS consumers see the request).
    expect(emitCalls.map((c) => c.type)).toContain(
      "content.public_publish_requested"
    );
  });

  it("downgrades even when the explicit publish_public capability is left false (no wildcard leak)", async () => {
    await contentService.create(staffUser, publicDoc, {});
    expect(insertedObjectValues?.visibilityLevel).toBe("private");
    expect(persistedApprovalValues?.requestKind).toBe("visibility_widen");
  });
});

describe("contentService.create — an AUTHORIZED caller is NOT downgraded", () => {
  it("persists 'public' and queues NOTHING for an admin", async () => {
    const result = await contentService.create(adminUser, publicDoc);
    expect(insertedObjectValues?.visibilityLevel).toBe("public");
    expect(result.visibilityLevel).toBe("public");
    // No widen request, no approval-queue event — the admin published as requested.
    expect(persistedApprovalValues).toBeNull();
    expect(
      emitCalls.some((c) => c.type === "content.public_publish_requested")
    ).toBe(false);
  });

  it("persists 'public' for a user WITH the explicit publish_public capability", async () => {
    await contentService.create(staffUser, publicDoc, {
      hasPublishPublicCapability: true,
    });
    expect(insertedObjectValues?.visibilityLevel).toBe("public");
    expect(persistedApprovalValues).toBeNull();
  });
});
