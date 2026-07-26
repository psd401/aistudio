/**
 * Dependency-injected OneRoster reconciliation core.
 *
 * The HTTP client stages a complete in-memory snapshot before this module writes
 * anything. A mid-pull x-perm-rev change discards that snapshot and restarts the
 * whole pull. Collection failures and unexpectedly empty collections never call
 * the DB reconciler, preserving their last-known-good rows.
 */

import {
  COLLECTIONS,
  RevisionChangedError,
  type CollectionName,
  type CollectionPullSuccess,
  type RosterPull,
} from "./oneroster-client";

export interface CollectionRunResult {
  name: CollectionName;
  synced: number;
  failed: number;
  deactivated: number;
  recordsTotal: number;
  error?: string;
}

export interface OneRosterSyncResult {
  unchanged: boolean;
  fullySuccessful: boolean;
  permRev: string | null;
  restartCount: number;
  collections: CollectionRunResult[];
}

export interface OneRosterSyncPorts {
  readLastPermRev(): Promise<string | null>;
  pullRoster(previousPermRev: string | null): Promise<RosterPull>;
  reconcileCollection(
    collection: CollectionPullSuccess
  ): Promise<{ synced: number; deactivated: number }>;
  writeLastPermRev(permRev: string): Promise<void>;
  log: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
}

const MAX_WHOLE_PULL_ATTEMPTS = 3;

export async function runOneRosterSync(
  ports: OneRosterSyncPorts
): Promise<OneRosterSyncResult> {
  const previousPermRev = await ports.readLastPermRev();
  let pull: RosterPull | null = null;
  let restartCount = 0;

  for (let attempt = 1; attempt <= MAX_WHOLE_PULL_ATTEMPTS; attempt += 1) {
    try {
      pull = await ports.pullRoster(previousPermRev);
      break;
    } catch (error) {
      if (
        !(error instanceof RevisionChangedError) ||
        attempt === MAX_WHOLE_PULL_ATTEMPTS
      ) {
        throw error;
      }
      restartCount += 1;
      ports.log.warn(
        "OneRoster revision changed during pull; discarding staged data and restarting",
        { attempt }
      );
    }
  }

  if (!pull) {
    throw new Error("OneRoster pull did not produce a snapshot");
  }
  if (pull.unchanged) {
    ports.log.info("OneRoster revision unchanged; skipping full reconciliation");
    return {
      unchanged: true,
      fullySuccessful: true,
      permRev: pull.permRev,
      restartCount,
      collections: COLLECTIONS.map((name) => ({
        name,
        synced: 0,
        failed: 0,
        deactivated: 0,
        recordsTotal: 0,
      })),
    };
  }

  const byName = new Map(pull.collections.map((entry) => [entry.name, entry]));
  const collectionResults: CollectionRunResult[] = [];

  for (const name of COLLECTIONS) {
    const collection = byName.get(name);
    if (!collection || !("records" in collection)) {
      const error =
        collection && "error" in collection
          ? collection.error
          : "collection was not returned";
      ports.log.error("OneRoster collection pull failed; preserving last-known-good rows", {
        collection: name,
        error,
      });
      collectionResults.push({
        name,
        synced: 0,
        failed: 1,
        deactivated: 0,
        recordsTotal: 0,
        error,
      });
      continue;
    }

    if (collection.records.length === 0) {
      const error = "collection returned zero records; reconciliation skipped";
      ports.log.warn(
        "OneRoster collection was empty; preserving last-known-good rows",
        { collection: name }
      );
      collectionResults.push({
        name,
        synced: 0,
        failed: 1,
        deactivated: 0,
        recordsTotal: 0,
        error,
      });
      continue;
    }

    try {
      const reconciled = await ports.reconcileCollection(collection);
      collectionResults.push({
        name,
        synced: reconciled.synced,
        failed: 0,
        deactivated: reconciled.deactivated,
        recordsTotal: collection.records.length,
      });
      ports.log.info("OneRoster collection reconciled", {
        collection: name,
        records: collection.records.length,
        deactivated: reconciled.deactivated,
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      ports.log.error(
        "OneRoster collection reconciliation failed; transaction rolled back",
        { collection: name, error: message }
      );
      collectionResults.push({
        name,
        synced: 0,
        failed: 1,
        deactivated: 0,
        recordsTotal: collection.records.length,
        error: message,
      });
    }
  }

  const fullySuccessful = collectionResults.every(
    (collection) => collection.failed === 0
  );
  // The checkpoint represents a fully-applied snapshot. Never advance it after
  // a partial/empty/DB-failed run or the next night could incorrectly no-op and
  // strand the failed collection at its old state.
  if (fullySuccessful && pull.permRev) {
    await ports.writeLastPermRev(pull.permRev);
  }

  return {
    unchanged: false,
    fullySuccessful,
    permRev: pull.permRev,
    restartCount,
    collections: collectionResults,
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
