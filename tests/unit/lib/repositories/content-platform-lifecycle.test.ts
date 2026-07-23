/** @jest-environment node */

import { jest } from "@jest/globals";
import {
  enforceNexusRepositoryLifecycle,
  NEXUS_PURGE_LEASE_MS,
  type NexusRepositoryLifecycleDependencies,
  type NexusRepositoryPurgeClaim,
} from "@/lib/repositories/content-platform/lifecycle-service";
import type { RepositoryStorageItem } from "@/lib/repositories/content-platform/storage-cleanup";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function claim(repositoryId: number): NexusRepositoryPurgeClaim {
  return {
    repositoryId,
    claimedAt: new Date(NOW.getTime() - 1_000),
  };
}

function item(repositoryId: number, id: number): RepositoryStorageItem {
  return {
    id,
    repositoryId,
    type: "document",
    source: `repositories/${repositoryId}/source-${id}.pdf`,
  };
}

function dependencies(
  claims: NexusRepositoryPurgeClaim[] = []
): NexusRepositoryLifecycleDependencies & {
  getConfig: jest.Mock<() => Promise<{ deletionGraceDays: number }>>;
  expire: jest.Mock<(now: Date) => Promise<number>>;
  claim: jest.Mock<
    NexusRepositoryLifecycleDependencies["claim"]
  >;
  listItems: jest.Mock<(repositoryId: number) => Promise<RepositoryStorageItem[]>>;
  deleteItemStorage: jest.Mock<(entry: RepositoryStorageItem) => Promise<void>>;
  deleteRepositoryStorage: jest.Mock<(repositoryId: number) => Promise<void>>;
  finalize: jest.Mock<(entry: NexusRepositoryPurgeClaim) => Promise<boolean>>;
  retainDeletingForRetry: jest.Mock<
    (entry: NexusRepositoryPurgeClaim, now: Date) => Promise<void>
  >;
} {
  return {
    getConfig: jest.fn(async () => ({ deletionGraceDays: 7 })),
    expire: jest.fn(async () => 2),
    claim: jest.fn(async () => claims),
    listItems: jest.fn(async (repositoryId) => [item(repositoryId, 10)]),
    deleteItemStorage: jest.fn(async () => undefined),
    deleteRepositoryStorage: jest.fn(async () => undefined),
    finalize: jest.fn(async () => true),
    retainDeletingForRetry: jest.fn(async () => undefined),
  };
}

describe("Nexus ephemeral repository lifecycle", () => {
  it("expires content immediately and claims purge work only after grace or a stale lease", async () => {
    const lifecycleDependencies = dependencies([claim(7)]);

    await expect(
      enforceNexusRepositoryLifecycle(
        { now: NOW, deletionGraceDays: 7, batchSize: 4 },
        lifecycleDependencies
      )
    ).resolves.toEqual({ expired: 2, purged: 1 });

    expect(lifecycleDependencies.expire).toHaveBeenCalledWith(NOW);
    expect(lifecycleDependencies.claim).toHaveBeenCalledWith({
      now: NOW,
      graceEndsBefore: new Date(NOW.getTime() - 7 * DAY_MS),
      staleLeaseBefore: new Date(NOW.getTime() - NEXUS_PURGE_LEASE_MS),
      batchSize: 4,
    });
  });

  it("deletes every source and artifact namespace before finalizing the database row", async () => {
    const lifecycleDependencies = dependencies([claim(7)]);
    lifecycleDependencies.listItems.mockResolvedValue([
      item(7, 10),
      item(7, 11),
    ]);
    const operations: string[] = [];
    lifecycleDependencies.deleteItemStorage.mockImplementation(async (entry) => {
      operations.push(`delete:${entry.id}`);
    });
    lifecycleDependencies.deleteRepositoryStorage.mockImplementation(
      async (repositoryId) => {
        operations.push(`sweep:${repositoryId}`);
      }
    );
    lifecycleDependencies.finalize.mockImplementation(async (entry) => {
      operations.push(`finalize:${entry.repositoryId}`);
      return true;
    });

    await enforceNexusRepositoryLifecycle(
      { now: NOW },
      lifecycleDependencies
    );

    expect(operations).toEqual([
      "delete:10",
      "delete:11",
      "sweep:7",
      "finalize:7",
    ]);
    expect(
      lifecycleDependencies.retainDeletingForRetry
    ).not.toHaveBeenCalled();
  });

  it("keeps a partially deleted purge fenced for stale-lease retry and continues other claims", async () => {
    const first = claim(7);
    const second = claim(8);
    const lifecycleDependencies = dependencies([first, second]);
    const operations: string[] = [];
    lifecycleDependencies.deleteItemStorage.mockImplementation(async (entry) => {
      operations.push(`delete:${entry.repositoryId}:${entry.id}`);
      if (entry.repositoryId === first.repositoryId && entry.id === 11) {
        throw new Error("simulated S3 failure");
      }
    });
    lifecycleDependencies.listItems.mockImplementation(async (repositoryId) => [
      item(repositoryId, 10),
      item(repositoryId, 11),
    ]);
    lifecycleDependencies.retainDeletingForRetry.mockImplementation(
      async (entry, releasedAt) => {
        operations.push(
          `retain-deleting:${entry.repositoryId}:${releasedAt.toISOString()}`
        );
      }
    );

    await expect(
      enforceNexusRepositoryLifecycle({ now: NOW }, lifecycleDependencies)
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "1 Nexus repository lifecycle operation(s) failed",
    });

    expect(
      lifecycleDependencies.retainDeletingForRetry
    ).toHaveBeenCalledWith(first, NOW);
    expect(operations).toEqual([
      "delete:7:10",
      "delete:7:11",
      `retain-deleting:7:${NOW.toISOString()}`,
      "delete:8:10",
      "delete:8:11",
    ]);
    expect(lifecycleDependencies.finalize).not.toHaveBeenCalledWith(first);
    expect(lifecycleDependencies.finalize).toHaveBeenCalledWith(second);
  });

  it.each([
    { deletionGraceDays: 0, batchSize: 10 },
    { deletionGraceDays: 366, batchSize: 10 },
    { deletionGraceDays: 7, batchSize: 0 },
    { deletionGraceDays: 7, batchSize: 101 },
  ])(
    "rejects unsafe lifecycle bounds %#",
    async ({ deletionGraceDays, batchSize }) => {
      const lifecycleDependencies = dependencies();

      await expect(
        enforceNexusRepositoryLifecycle(
          { now: NOW, deletionGraceDays, batchSize },
          lifecycleDependencies
        )
      ).rejects.toThrow();

      expect(lifecycleDependencies.expire).not.toHaveBeenCalled();
      expect(lifecycleDependencies.claim).not.toHaveBeenCalled();
    }
  );
});
