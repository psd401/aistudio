/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetServerSession = jest.fn(
  () => Promise.resolve({ sub: "admin-user" } as { sub: string } | null)
);
const mockHasRole = jest.fn(() => Promise.resolve(true));
const mockAssertNotSystemManagedRepository = jest.fn<
  (repositoryId: number) => Promise<void>
>(() => Promise.resolve());
const mockAssertDeletionBoundary = jest.fn<
  (repositoryId: number) => Promise<void>
>(() => Promise.resolve());
const mockGetAllRepositoriesWithOwner = jest.fn<
  (options?: { includeDeleting?: boolean }) => Promise<unknown[]>
>(
  () => Promise.resolve([])
);
const mockGetRepositoryItems = jest.fn<
  (repositoryId: number) => Promise<unknown[]>
>(() => Promise.resolve([]));
const mockGetRepositoryItemById = jest.fn<
  (itemId: number) => Promise<unknown>
>();
const mockDeleteRepository = jest.fn<
  (repositoryId: number) => Promise<number>
>(() => Promise.resolve(1));
const mockDeleteRepositoryItem = jest.fn<
  (itemId: number) => Promise<number>
>(() => Promise.resolve(1));
const mockDeleteRepositoryStorageTree = jest.fn<
  (...args: unknown[]) => Promise<unknown>
>();
const mockDeleteRepositoryItemStorage = jest.fn<
  (...args: unknown[]) => Promise<unknown>
>();
const mockBeginRepositoryDeletion = jest.fn<
  (repositoryId: number) => Promise<unknown[]>
>(() => Promise.resolve([]));
const mockBeginRepositoryItemDeletion = jest.fn<
  (input: { repositoryId: number; itemId: number }) => Promise<{
    id: number;
    repositoryId: number;
    type: string;
    source: string;
  }>
>();
const mockFinalizeRepositoryDeletion = jest.fn<
  (repositoryId: number) => Promise<boolean>
>(() => Promise.resolve(true));
const mockFinalizeRepositoryItemDeletion = jest.fn<
  (itemId: number) => Promise<boolean>
>(() => Promise.resolve(true));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: mockGetServerSession,
}));
jest.mock("@/utils/roles", () => ({ hasRole: mockHasRole }));
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertNotSystemManagedRepository: mockAssertNotSystemManagedRepository,
  assertUserManagedDurableRepositoryForDeletion: mockAssertDeletionBoundary,
}));
jest.mock("@/lib/db/drizzle", () => ({
  getAllRepositoriesWithOwner: mockGetAllRepositoriesWithOwner,
  updateRepository: jest.fn(),
  deleteRepository: mockDeleteRepository,
  getRepositoryItems: mockGetRepositoryItems,
  getRepositoryItemById: mockGetRepositoryItemById,
  deleteRepositoryItem: mockDeleteRepositoryItem,
  isSystemManagedRepository: jest.fn(() => false),
}));
jest.mock("@/lib/repositories/content-platform/storage-cleanup", () => ({
  deleteRepositoryStorageTree: mockDeleteRepositoryStorageTree,
  deleteRepositoryItemStorage: mockDeleteRepositoryItemStorage,
}));
jest.mock("@/lib/repositories/content-platform/deletion-service", () => ({
  beginRepositoryDeletion: mockBeginRepositoryDeletion,
  beginRepositoryItemDeletion: mockBeginRepositoryItemDeletion,
  finalizeRepositoryDeletion: mockFinalizeRepositoryDeletion,
  finalizeRepositoryItemDeletion: mockFinalizeRepositoryItemDeletion,
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-id",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
  getLogContext: () => ({}),
}));

describe("admin repository deletion storage safety", () => {
  let actions: typeof import("@/actions/admin/repositories.actions");

  beforeAll(async () => {
    actions = await import("@/actions/admin/repositories.actions");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ sub: "admin-user" });
    mockHasRole.mockResolvedValue(true);
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined);
    mockAssertDeletionBoundary.mockResolvedValue(undefined);
    mockGetAllRepositoriesWithOwner.mockResolvedValue([]);
    mockGetRepositoryItems.mockResolvedValue([]);
    mockDeleteRepository.mockResolvedValue(1);
    mockDeleteRepositoryItem.mockResolvedValue(1);
    mockBeginRepositoryDeletion.mockResolvedValue([]);
    mockBeginRepositoryItemDeletion.mockImplementation(
      async ({ repositoryId, itemId }) => {
        const item = (await mockGetRepositoryItemById(itemId)) as {
          type: string;
          source: string;
        };
        return { id: itemId, repositoryId, type: item.type, source: item.source };
      }
    );
    mockFinalizeRepositoryDeletion.mockResolvedValue(true);
    mockFinalizeRepositoryItemDeletion.mockResolvedValue(true);
    mockDeleteRepositoryStorageTree.mockResolvedValue({
      itemCount: 0,
      sourceObjectCount: 0,
      artifactObjectCount: 0,
      repositoryObjectCount: 0,
    });
    mockDeleteRepositoryItemStorage.mockResolvedValue({
      sourceObjectCount: 0,
      artifactObjectCount: 0,
    });
  });

  it("lists active repositories and reachable deletion retries in Repository Manager", async () => {
    const baseRepository = {
      id: 1,
      name: "Durable",
      description: null,
      ownerId: 2,
      ownerEmail: "owner@example.com",
      isPublic: false,
      repositoryKind: "durable",
      lifecycleStatus: "active",
      retentionDays: null,
      expiresAt: null,
      activeIndexGenerationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      itemCount: 1,
    };
    mockGetAllRepositoriesWithOwner.mockResolvedValue([
      baseRepository,
      { ...baseRepository, id: 2, repositoryKind: "ephemeral" },
      { ...baseRepository, id: 3, repositoryKind: "system" },
      { ...baseRepository, id: 4, lifecycleStatus: "expired" },
      {
        ...baseRepository,
        id: 5,
        expiresAt: new Date(Date.now() - 60_000),
      },
      { ...baseRepository, id: 6, lifecycleStatus: "deleting" },
    ]);

    const result = await actions.listAllRepositories();

    expect(result.isSuccess).toBe(true);
    expect(mockGetAllRepositoriesWithOwner).toHaveBeenCalledWith({
      includeDeleting: true,
    });
    expect(result.data).toEqual([
      expect.objectContaining({ id: 1, repositoryKind: "durable" }),
      expect.objectContaining({ id: 6, lifecycleStatus: "deleting" }),
    ]);
  });

  it("cleans all item types and the repository prefix before deleting manifests", async () => {
    const items = ["text", "document", "image", "audio", "video"].map(
      (type, index) => ({
        id: index + 1,
        repositoryId: 7,
        type,
        source:
          type === "text"
            ? "Inline text"
            : `repositories/7/source/source-${index + 1}`,
      })
    );
    mockBeginRepositoryDeletion.mockResolvedValue(items);

    const result = await actions.adminDeleteRepository(7);

    expect(result.isSuccess).toBe(true);
    expect(mockDeleteRepositoryStorageTree).toHaveBeenCalledWith(7, items);
    expect(
      mockDeleteRepositoryStorageTree.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockFinalizeRepositoryDeletion.mock.invocationCallOrder[0]!
    );
  });

  it("preserves repository manifests when storage cleanup fails", async () => {
    mockBeginRepositoryDeletion.mockResolvedValue([
      {
        id: 1,
        repositoryId: 7,
        type: "document",
        source: "repositories/7/source/policy.pdf",
      },
    ]);
    mockDeleteRepositoryStorageTree.mockRejectedValueOnce(
      new Error("storage unavailable")
    );

    const result = await actions.adminDeleteRepository(7);

    expect(result.isSuccess).toBe(false);
    expect(mockFinalizeRepositoryDeletion).not.toHaveBeenCalled();
  });

  it("masks non-durable repositories before listing or cleaning their storage", async () => {
    mockAssertDeletionBoundary.mockRejectedValueOnce(
      new Error("Record not found")
    );

    const result = await actions.adminDeleteRepository(7);

    expect(result.isSuccess).toBe(false);
    expect(mockBeginRepositoryDeletion).not.toHaveBeenCalled();
    expect(mockDeleteRepositoryStorageTree).not.toHaveBeenCalled();
    expect(mockFinalizeRepositoryDeletion).not.toHaveBeenCalled();
  });

  it.each(["text", "document", "image", "audio", "video"])(
    "cleans %s storage before deleting its item manifest",
    async (type) => {
      const item = {
        id: 21,
        repositoryId: 7,
        type,
        source:
          type === "text"
            ? "Inline text"
            : `repositories/7/source/source.${type}`,
      };
      mockGetRepositoryItemById.mockResolvedValue(item);

      const result = await actions.adminRemoveRepositoryItem(21);

      expect(result.isSuccess).toBe(true);
      expect(mockDeleteRepositoryItemStorage).toHaveBeenCalledWith(item);
      expect(
        mockDeleteRepositoryItemStorage.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockFinalizeRepositoryItemDeletion.mock.invocationCallOrder[0]!
      );
    }
  );

  it("preserves an item manifest when storage cleanup fails", async () => {
    mockGetRepositoryItemById.mockResolvedValue({
      id: 21,
      repositoryId: 7,
      type: "video",
      source: "repositories/7/source/training.mp4",
    });
    mockDeleteRepositoryItemStorage.mockRejectedValueOnce(
      new Error("storage unavailable")
    );

    const result = await actions.adminRemoveRepositoryItem(21);

    expect(result.isSuccess).toBe(false);
    expect(mockFinalizeRepositoryItemDeletion).not.toHaveBeenCalled();
  });
});
