/** @jest-environment node */

import {
  isSelectionSnapshotPending,
  reconcileChangePages,
  resumePendingSelectionSnapshot,
  SELECTION_SNAPSHOT_PENDING_KEY,
  shouldRetireUnseenSources,
  type ChangesPage,
  type ReconcileChangesDeps,
} from "../../infra/lambdas/google-content-sync/reconcile";

interface Recorder {
  events: string[];
  cursors: string[];
  deps: ReconcileChangesDeps<string>;
}

function page(
  values: string[],
  nextPageToken: string | null,
  newStartPageToken: string | null = null,
): ChangesPage<string> {
  return { values, nextPageToken, newStartPageToken };
}

function recorder(options: {
  pages: Array<ChangesPage<string>>;
  demandsSnapshot?: (change: string) => boolean;
  snapshotComplete?: boolean;
  snapshotThrows?: boolean;
}): Recorder {
  const events: string[] = [];
  const cursors: string[] = [];
  let pageIndex = 0;
  return {
    events,
    cursors,
    deps: {
      listChanges: async (cursor) => {
        events.push(`list:${cursor}`);
        const next = options.pages[pageIndex];
        pageIndex += 1;
        if (!next) throw new Error("listChanges called more times than staged");
        return next;
      },
      processChange: async (change) => {
        events.push(`process:${change}`);
        return options.demandsSnapshot?.(change) ?? false;
      },
      persistCursor: async (cursor) => {
        events.push(`persist:${cursor}`);
        cursors.push(cursor);
      },
      markSnapshotPending: async () => {
        events.push("mark-pending");
      },
      runSelectionSnapshot: async () => {
        events.push("snapshot");
        if (options.snapshotThrows) throw new Error("snapshot failed");
        return options.snapshotComplete ?? true;
      },
      clearSnapshotPending: async () => {
        events.push("clear-pending");
      },
    },
  };
}

describe("selection snapshot obligation flag", () => {
  test("is detected only when the connector metadata carries a timestamp", () => {
    expect(isSelectionSnapshotPending(undefined)).toBe(false);
    expect(isSelectionSnapshotPending(null)).toBe(false);
    expect(isSelectionSnapshotPending({})).toBe(false);
    expect(
      isSelectionSnapshotPending({
        [SELECTION_SNAPSHOT_PENDING_KEY]: "2026-08-07T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("reconcileChangePages cursor durability", () => {
  test("advances the cursor after every page", async () => {
    const { deps, cursors } = recorder({
      pages: [page(["a"], "cursor-2"), page(["b"], null, "start-3")],
    });

    const cursor = await reconcileChangePages("cursor-1", deps);

    expect(cursors).toEqual(["cursor-2", "start-3"]);
    expect(cursor).toBe("start-3");
  });

  test("keeps advancing the cursor while a snapshot obligation is outstanding", async () => {
    // This is the regression: the old loop suppressed every per-page cursor
    // write once a page demanded a snapshot, so a Lambda timeout replayed all
    // of the already-processed change pages on the next attempt.
    const { deps, cursors, events } = recorder({
      pages: [page(["removal"], "cursor-2"), page(["b"], null, "start-3")],
      demandsSnapshot: (change) => change === "removal",
    });

    await reconcileChangePages("cursor-1", deps);

    expect(cursors).toEqual(["cursor-2", "start-3"]);
    // The obligation is durable BEFORE the cursor moves past the page that
    // raised it — a crash in between can only replay work, never lose it.
    expect(events.indexOf("mark-pending")).toBeLessThan(
      events.indexOf("persist:cursor-2"),
    );
  });

  test("records the obligation once, no matter how many entries demand it", async () => {
    const { deps, events } = recorder({
      pages: [page(["r1", "r2", "r3"], null, "start-2")],
      demandsSnapshot: () => true,
    });

    await reconcileChangePages("cursor-1", deps);

    expect(events.filter((event) => event === "mark-pending")).toHaveLength(1);
  });

  test("runs the snapshot after the feed is drained and clears the flag", async () => {
    const { deps, events } = recorder({
      pages: [page(["removal"], "cursor-2"), page([], null, "start-3")],
      demandsSnapshot: () => true,
    });

    await reconcileChangePages("cursor-1", deps);

    expect(events).toEqual([
      "list:cursor-1",
      "process:removal",
      "mark-pending",
      "persist:cursor-2",
      "list:cursor-2",
      "persist:start-3",
      "snapshot",
      "clear-pending",
    ]);
  });

  test("leaves the flag set when the snapshot enumeration was incomplete", async () => {
    // An incomplete enumeration never feeds the unseen-source sweep, so the
    // obligation is not discharged and the next run retries it.
    const { deps, events } = recorder({
      pages: [page(["removal"], null, "start-2")],
      demandsSnapshot: () => true,
      snapshotComplete: false,
    });

    await reconcileChangePages("cursor-1", deps);

    expect(events).toContain("snapshot");
    expect(events).not.toContain("clear-pending");
  });

  test("leaves the flag set when the snapshot throws, after the cursor advanced", async () => {
    const { deps, cursors, events } = recorder({
      pages: [page(["removal"], null, "start-2")],
      demandsSnapshot: () => true,
      snapshotThrows: true,
    });

    await expect(reconcileChangePages("cursor-1", deps)).rejects.toThrow(
      "snapshot failed",
    );

    // The change-page work is banked; only the snapshot is retried.
    expect(cursors).toEqual(["start-2"]);
    expect(events).not.toContain("clear-pending");
  });

  test("never marks the obligation when no entry demands a snapshot", async () => {
    const { deps, events } = recorder({
      pages: [page(["a", "b"], null, "start-2")],
    });

    await reconcileChangePages("cursor-1", deps);

    expect(events).not.toContain("mark-pending");
    expect(events).not.toContain("snapshot");
  });

  test("holds the cursor when Google returns neither token", async () => {
    const { deps, cursors } = recorder({ pages: [page(["a"], null, null)] });

    const cursor = await reconcileChangePages("cursor-1", deps);

    expect(cursor).toBe("cursor-1");
    expect(cursors).toEqual(["cursor-1"]);
  });
});

describe("resumePendingSelectionSnapshot", () => {
  test("discharges the obligation only after a complete snapshot", async () => {
    const events: string[] = [];
    const complete = await resumePendingSelectionSnapshot({
      runSelectionSnapshot: async () => {
        events.push("snapshot");
        return true;
      },
      clearSnapshotPending: async () => {
        events.push("clear-pending");
      },
    });

    expect(complete).toBe(true);
    expect(events).toEqual(["snapshot", "clear-pending"]);
  });

  test("keeps the obligation when the snapshot was incomplete", async () => {
    const events: string[] = [];
    const complete = await resumePendingSelectionSnapshot({
      runSelectionSnapshot: async () => {
        events.push("snapshot");
        return false;
      },
      clearSnapshotPending: async () => {
        events.push("clear-pending");
      },
    });

    expect(complete).toBe(false);
    expect(events).toEqual(["snapshot"]);
  });
});

describe("shouldRetireUnseenSources", () => {
  test("allows the sweep only after a complete enumeration", () => {
    expect(shouldRetireUnseenSources({ skippedEntryCount: 0 })).toBe(true);
  });

  test("blocks the sweep when any entry was dropped by validation", () => {
    // Marking a still-existing file missing because one record was
    // unreadable would be silent data loss.
    expect(shouldRetireUnseenSources({ skippedEntryCount: 1 })).toBe(false);
    expect(shouldRetireUnseenSources({ skippedEntryCount: 250 })).toBe(false);
  });
});
