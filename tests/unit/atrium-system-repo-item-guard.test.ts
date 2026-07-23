/**
 * Security regression: repository read actions keyed by ITEM id must enforce
 * per-repository authorization.
 *
 * `getItemChunks(itemId)` returned raw `repository_item_chunks.content` after
 * only a generic capability check — keyed by item id, so neither the ownership
 * checks nor the repositoryId-based guards covered it. Any capability holder
 * could read another repository's chunks (generic IDOR), and once Atrium content
 * was indexed into the shared table, restricted Atrium text (Issue #1056).
 *
 * Covers the shared guards (`assertRepositoryReadAccess`,
 * `assertItemRepositoryReadAccess`, `assertNotSystemManagedRepository`) directly,
 * plus the `getItemChunks` wiring (no chunk read for an inaccessible item).
 */

let accessibleRepoIds: Set<number> = new Set();
let itemById: Record<number, unknown> = {};
let repoById: Record<number, unknown> = {};
let isAdministrator = false;

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "user-1" })),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
  hasRole: jest.fn(async () => true),
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/lib/aws/s3-client", () => ({
  uploadDocument: jest.fn(), deleteDocument: jest.fn(),
}));
jest.mock("@/lib/services/file-processing-service", () => ({
  queueFileForProcessing: jest.fn(), processUrl: jest.fn(),
}));
jest.mock("./../../actions/repositories/repository-permissions", () => ({
  canModifyRepository: jest.fn(async () => true),
  getUserIdFromSession: jest.fn(async () => 1),
}));

jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: jest.fn(async (ids: number[]) =>
    ids.map((id) => ({ id, name: "r", isAccessible: accessibleRepoIds.has(id) }))
  ),
  getRepositoryItemById: jest.fn(async (id: number) => itemById[id] ?? null),
  getRepositoryById: jest.fn(async (id: number) => repoById[id] ?? null),
  checkUserRoleByCognitoSub: jest.fn(async () => isAdministrator),
  isSystemManagedRepository: (repo: { metadata?: unknown } | null | undefined) =>
    (repo?.metadata as Record<string, unknown> | null | undefined)?.systemManaged === true,
  getRepositoryItemChunks: jest.fn(async () => [
    { id: 1, itemId: 5, content: "restricted text", embedding: null, metadata: {}, chunkIndex: 0, tokens: null, createdAt: new Date(0) },
  ]),
  // other barrel exports repository-items.actions imports
  createRepositoryItem: jest.fn(),
  getRepositoryItems: jest.fn(async () => []),
  deleteRepositoryItem: jest.fn(),
  updateRepositoryItemStatus: jest.fn(),
}));

import {
  assertRepositoryReadAccess,
  assertItemRepositoryReadAccess,
  assertUserManagedDurableRepository,
  assertNotSystemManagedRepository,
} from "@/lib/repositories/repository-access-guard";
import { getItemChunks } from "@/actions/repositories/repository-items.actions";
import { getRepositoryItemChunks } from "@/lib/db/drizzle";

const getChunksMock = getRepositoryItemChunks as jest.Mock;

beforeEach(() => {
  accessibleRepoIds = new Set([3, 4]); // repo 4 is accessible but ephemeral
  isAdministrator = false;
  itemById = {
    5: { id: 5, repositoryId: 9 }, // in an inaccessible repo
    6: { id: 6, repositoryId: 3 }, // in an accessible repo
  };
  repoById = {
    9: {
      id: 9,
      repositoryKind: "system",
      lifecycleStatus: "active",
      expiresAt: null,
      metadata: { systemManaged: true },
    },
    3: {
      id: 3,
      repositoryKind: "durable",
      lifecycleStatus: "active",
      expiresAt: null,
      metadata: null,
    },
    4: {
      id: 4,
      repositoryKind: "ephemeral",
      lifecycleStatus: "active",
      expiresAt: new Date("2026-07-24T00:00:00Z"),
      metadata: null,
    },
    7: {
      id: 7,
      repositoryKind: "durable",
      lifecycleStatus: "active",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      metadata: null,
    },
    8: {
      id: 8,
      repositoryKind: "durable",
      lifecycleStatus: "active",
      expiresAt: null,
      metadata: null,
    },
  };
  getChunksMock.mockClear();
});

describe("shared repository-access guards", () => {
  it("assertRepositoryReadAccess throws for an inaccessible repo, resolves for an accessible one", async () => {
    await expect(assertRepositoryReadAccess(3, "user-1")).resolves.toBeUndefined();
    await expect(assertRepositoryReadAccess(9, "user-1")).rejects.toBeDefined();
  });

  it("allows administrators to read private durable repositories only", async () => {
    await expect(assertRepositoryReadAccess(8, "user-1")).rejects.toBeDefined();

    isAdministrator = true;
    await expect(assertRepositoryReadAccess(8, "user-1")).resolves.toBeUndefined();
    await expect(assertRepositoryReadAccess(4, "user-1")).rejects.toBeDefined();
    await expect(assertRepositoryReadAccess(9, "user-1")).rejects.toBeDefined();
  });

  it("assertItemRepositoryReadAccess throws for an item in an inaccessible repo", async () => {
    await expect(assertItemRepositoryReadAccess(6, "user-1")).resolves.toBeUndefined(); // repo 3
    await expect(assertItemRepositoryReadAccess(5, "user-1")).rejects.toBeDefined();    // repo 9
    await expect(assertItemRepositoryReadAccess(404, "user-1")).rejects.toBeDefined();  // missing item
  });

  it("allows only active, unexpired, user-managed durable repositories", async () => {
    await expect(assertUserManagedDurableRepository(3)).resolves.toBeUndefined();
    await expect(assertUserManagedDurableRepository(4)).rejects.toBeDefined(); // ephemeral
    await expect(assertUserManagedDurableRepository(7)).rejects.toBeDefined(); // expired
    await expect(assertNotSystemManagedRepository(9)).rejects.toBeDefined(); // system
    await expect(assertNotSystemManagedRepository(3)).resolves.toBeUndefined(); // normal
    await expect(assertNotSystemManagedRepository(404)).rejects.toBeDefined(); // missing
  });
});

describe("getItemChunks — no raw chunk read for an inaccessible item", () => {
  it("REFUSES to return chunks for an item the caller cannot access", async () => {
    const result = await getItemChunks(5); // repo 9, not accessible
    expect(result.isSuccess).toBe(false);
    // The safety guarantee: the chunk content query never ran.
    expect(getChunksMock).not.toHaveBeenCalled();
  });

  it("ALLOWS reading chunks for an item in an accessible repository", async () => {
    const result = await getItemChunks(6); // repo 3, accessible
    expect(result.isSuccess).toBe(true);
    expect(getChunksMock).toHaveBeenCalledWith(6);
  });
});
