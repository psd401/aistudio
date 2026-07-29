/** @jest-environment node */

let mode: "create" | "update" = "create";
let outsideRows: Array<Array<Record<string, unknown>>> = [];
let insertedValues: Record<string, unknown> | null = null;
let updatedValues: Record<string, unknown> | null = null;

const collectionAccessSnapshotMock = jest.fn();
const collectionAccessSnapshotInTxMock = jest.fn();
jest.mock("@/lib/content/collection-access", () => ({
  collectionAccessSnapshot: (...args: unknown[]) =>
    collectionAccessSnapshotMock(...args),
  collectionAccessSnapshotInTx: (...args: unknown[]) =>
    collectionAccessSnapshotInTxMock(...args),
}));

const applyGrantsForLevelMock = jest.fn(
  async (..._args: unknown[]) => undefined
);
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => true),
    assertWritableLevel: jest.fn(),
    applyGrantsForLevel: (...args: unknown[]) =>
      applyGrantsForLevelMock(...args),
  },
}));

const lockedObject = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "document",
  title: "Existing",
  slug: "existing",
  ownerUserId: 7,
  collectionId: null,
  visibilityLevel: "private",
  status: "draft",
  tags: [],
};

const lockedLimitMock = jest.fn(async () => [lockedObject]);
const lockedForMock = jest.fn(() => ({ limit: lockedLimitMock }));
const selectWhereMock = jest.fn(() =>
  mode === "create"
    ? Promise.resolve([])
    : { for: lockedForMock }
);
const selectFromMock = jest.fn(() => ({ where: selectWhereMock }));
const insertReturningMock = jest.fn(async () => [
  {
    id: "22222222-2222-2222-2222-222222222222",
    ...(insertedValues ?? {}),
  },
]);
const insertValuesMock = jest.fn((values: Record<string, unknown>) => {
  insertedValues = values;
  return { returning: insertReturningMock };
});
const updateReturningMock = jest.fn(async () => [
  { ...lockedObject, ...(updatedValues ?? {}) },
]);
const updateWhereMock = jest.fn(() => ({
  returning: updateReturningMock,
}));
const updateSetMock = jest.fn((values: Record<string, unknown>) => {
  updatedValues = values;
  return { where: updateWhereMock };
});
const txStub = {
  select: jest.fn(() => ({ from: selectFromMock })),
  insert: jest.fn(() => ({
    values: insertValuesMock,
  })),
  update: jest.fn(() => ({
    set: updateSetMock,
  })),
};

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => outsideRows.shift() ?? []),
  executeTransaction: jest.fn(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub)
  ),
}));
jest.mock("@/lib/db/schema", () => ({
  contentAuditLogs: {},
  contentCollections: {},
  contentObjects: { id: {}, slug: {} },
  contentPublications: {},
  contentVersions: {},
  navigationItems: {},
}));
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (value: unknown) => JSON.stringify(value),
}));
jest.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  count: (value: unknown) => value,
  eq: (...args: unknown[]) => args,
  gte: (...args: unknown[]) => args,
  isNull: (value: unknown) => value,
  like: (...args: unknown[]) => args,
  sql: Object.assign((..._args: unknown[]) => ({}), { join: () => ({}) }),
}));
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: { flushSnapshotWrites: jest.fn(async () => undefined) },
}));
jest.mock("@/lib/content/agent-screening", () => ({
  screenAgentBodyForWrite: jest.fn(async () => null),
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));

import { contentService } from "@/lib/content/content-service";
import { ForbiddenError } from "@/lib/content/errors";
import type {
  CollectionGrant,
  Requester,
  VisibilityLevel,
} from "@/lib/content/types";

const requester: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const collectionId = "33333333-3333-3333-3333-333333333333";

function accessSnapshot(input: {
  level?: VisibilityLevel;
  archived?: boolean;
  selectable?: boolean;
  grants?: CollectionGrant[];
}) {
  const collection = {
    id: collectionId,
    name: "Policies",
    slug: "policies",
    parentId: null,
    ownerUserId: null,
    defaultVisibilityLevel: input.level ?? "internal",
    inheritGrants: true,
    position: 0,
    archivedAt: input.archived ? new Date() : null,
  };
  return {
    collections: [collection],
    byId: new Map([[collectionId, collection]]),
    directGrants: new Map(),
    effectiveGrants: jest.fn(() => input.grants ?? []),
    allowedCollectionIds: new Set([collectionId]),
    selectableCollectionIds: new Set(
      input.selectable === false ? [] : [collectionId]
    ),
  };
}

beforeEach(() => {
  mode = "create";
  outsideRows = [];
  insertedValues = null;
  updatedValues = null;
  jest.clearAllMocks();
  collectionAccessSnapshotMock.mockResolvedValue(accessSnapshot({}));
  collectionAccessSnapshotInTxMock.mockResolvedValue(accessSnapshot({}));
});

describe("content collection placement transaction boundary", () => {
  it("rejects a create when access is revoked after preflight", async () => {
    collectionAccessSnapshotInTxMock.mockResolvedValue(
      accessSnapshot({ archived: true, selectable: false })
    );

    await expect(
      contentService.create(requester, {
        kind: "document",
        title: "Policy",
        collectionId,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(collectionAccessSnapshotInTxMock).toHaveBeenCalledWith(
      txStub,
      requester
    );
    expect(txStub.insert).not.toHaveBeenCalled();
  });

  it("persists the locked current default and grants, not stale preflight values", async () => {
    const viewGrant: CollectionGrant = {
      access: "view",
      kind: "role",
      value: "staff",
    };
    collectionAccessSnapshotInTxMock.mockResolvedValue(
      accessSnapshot({ level: "group", grants: [viewGrant] })
    );

    await contentService.create(requester, {
      kind: "document",
      title: "Policy",
      collectionId,
    });

    expect(insertedValues?.visibilityLevel).toBe("group");
    expect(applyGrantsForLevelMock.mock.calls[0][3]).toEqual([
      { kind: "role", value: "staff" },
    ]);
  });

  it("rejects a move when target access is revoked before the update", async () => {
    mode = "update";
    outsideRows = [[lockedObject]];
    collectionAccessSnapshotInTxMock.mockResolvedValue(
      accessSnapshot({ selectable: false })
    );

    await expect(
      contentService.update(requester, lockedObject.id, { collectionId })
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(collectionAccessSnapshotInTxMock).toHaveBeenCalledWith(
      txStub,
      requester
    );
    expect(txStub.update).not.toHaveBeenCalled();
    expect(updatedValues).toBeNull();
  });
});
