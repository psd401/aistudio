import { describe, expect, it } from "bun:test";
import {
  COLLECTIONS,
  RevisionChangedError,
  type CollectionName,
  type RosterPull,
} from "./oneroster-client";
import { runOneRosterSync, type OneRosterSyncPorts } from "./sync";

function completePull(): RosterPull {
  return {
    unchanged: false,
    permRev: "rev-2",
    collections: COLLECTIONS.map((name) => ({
      name,
      records: [{ sourcedId: `${name}-1`, title: "Changed" }],
      permRev: "rev-2",
      complete: true as const,
    })),
  };
}

function testPorts(
  overrides: Partial<OneRosterSyncPorts> = {}
): OneRosterSyncPorts & {
  reconciled: CollectionName[];
  checkpoints: string[];
} {
  const reconciled: CollectionName[] = [];
  const checkpoints: string[] = [];
  return {
    reconciled,
    checkpoints,
    readLastPermRev: async () => "rev-1",
    pullRoster: async () => completePull(),
    reconcileCollection: async (collection) => {
      reconciled.push(collection.name);
      return { synced: collection.records.length, deactivated: 2 };
    },
    writeLastPermRev: async (permRev) => {
      checkpoints.push(permRev);
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  };
}

describe("runOneRosterSync fail-safety", () => {
  it("reconciles complete collections, reports absence deactivations, and checkpoints", async () => {
    const ports = testPorts();

    const result = await runOneRosterSync(ports);

    expect(result.fullySuccessful).toBe(true);
    expect(ports.reconciled).toEqual([...COLLECTIONS]);
    expect(result.collections.every((entry) => entry.deactivated === 2)).toBe(
      true
    );
    expect(ports.checkpoints).toEqual(["rev-2"]);
  });

  it("preserves last-known-good rows for an errored collection", async () => {
    const pull = completePull();
    pull.collections = pull.collections.map((collection) =>
      collection.name === "users"
        ? { name: "users", error: "upstream failed" }
        : collection
    );
    const ports = testPorts({ pullRoster: async () => pull });

    const result = await runOneRosterSync(ports);

    expect(result.fullySuccessful).toBe(false);
    expect(ports.reconciled).not.toContain("users");
    expect(result.collections.find((entry) => entry.name === "users")).toEqual(
      expect.objectContaining({ failed: 1, deactivated: 0 })
    );
    expect(ports.checkpoints).toEqual([]);
  });

  it("does not reconcile or deactivate an unexpectedly empty collection", async () => {
    const pull = completePull();
    pull.collections = pull.collections.map((collection) =>
      collection.name === "enrollments"
        ? { ...collection, records: [] }
        : collection
    );
    const ports = testPorts({ pullRoster: async () => pull });

    const result = await runOneRosterSync(ports);

    expect(ports.reconciled).not.toContain("enrollments");
    expect(
      result.collections.find((entry) => entry.name === "enrollments")
    ).toEqual(expect.objectContaining({ failed: 1, deactivated: 0 }));
    expect(ports.checkpoints).toEqual([]);
  });

  it("isolates a collection transaction failure and does not checkpoint", async () => {
    const ports = testPorts({
      reconcileCollection: async (collection) => {
        if (collection.name === "classes") {
          throw new Error("transaction rolled back");
        }
        return { synced: 1, deactivated: 0 };
      },
    });

    const result = await runOneRosterSync(ports);

    expect(result.fullySuccessful).toBe(false);
    expect(result.collections.find((entry) => entry.name === "classes")).toEqual(
      expect.objectContaining({
        failed: 1,
        deactivated: 0,
        error: "transaction rolled back",
      })
    );
    expect(ports.checkpoints).toEqual([]);
  });

  it("discards staged data and performs a bounded full restart on revision change", async () => {
    let attempts = 0;
    const ports = testPorts({
      pullRoster: async () => {
        attempts += 1;
        if (attempts < 3) throw new RevisionChangedError();
        return completePull();
      },
    });

    const result = await runOneRosterSync(ports);

    expect(attempts).toBe(3);
    expect(result.restartCount).toBe(2);
    expect(result.fullySuccessful).toBe(true);
  });

  it("fails after the third revision change without touching the database", async () => {
    const ports = testPorts({
      pullRoster: async () => {
        throw new RevisionChangedError();
      },
    });

    await expect(runOneRosterSync(ports)).rejects.toBeInstanceOf(
      RevisionChangedError
    );
    expect(ports.reconciled).toEqual([]);
    expect(ports.checkpoints).toEqual([]);
  });

  it("treats an unchanged persistent revision as a successful no-op", async () => {
    const ports = testPorts({
      pullRoster: async () => ({
        unchanged: true,
        permRev: "rev-1",
        collections: [],
      }),
    });

    const result = await runOneRosterSync(ports);

    expect(result.unchanged).toBe(true);
    expect(result.fullySuccessful).toBe(true);
    expect(ports.reconciled).toEqual([]);
    expect(ports.checkpoints).toEqual([]);
    expect(result.collections).toHaveLength(6);
  });
});
