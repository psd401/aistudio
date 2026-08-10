/**
 * Classification helpers for entries returned by the Google Drive Changes
 * feed (`GET /drive/v3/changes`).
 *
 * The feed is not exclusively file-scoped. Google emits `changeType: "drive"`
 * entries for Shared Drive-level events — rename, membership change,
 * restriction change — and those entries carry NO `fileId`. There is no file
 * to import, resolve, or mark missing for them.
 *
 * Every downstream step of the reconcile loop is keyed on a file id, so a
 * `fileId`-less entry must be skipped before that work begins. `changeType` is
 * matched as a plain string rather than an enum so a future value Google adds
 * cannot turn the queue into poison messages again.
 */

/** Shared Drive-scoped change entries never carry a `fileId`. */
export const DRIVE_SCOPED_CHANGE_TYPE = "drive";

/** The minimum shape needed to decide whether a change entry is actionable. */
export interface DriveChangeIdentity {
  changeType?: string | undefined;
  fileId?: string | undefined;
  removed?: boolean | undefined;
}

/**
 * True when the entry names a specific Drive file, i.e. it is safe to hand to
 * the file-scoped import/removal path. Drive-scoped entries and entries with a
 * missing or empty `fileId` return false and must be skipped.
 */
export function isFileScopedDriveChange<T extends DriveChangeIdentity>(
  change: T,
): change is T & { fileId: string } {
  if (change.changeType === DRIVE_SCOPED_CHANGE_TYPE) return false;
  return typeof change.fileId === "string" && change.fileId.length > 0;
}

/**
 * True when a non-file-scoped entry reports that the Shared Drive itself went
 * away — deleted, or this account lost access to it.
 *
 * These entries must NOT be skipped like the other drive-scoped noise. Sources
 * already imported from that drive are now unreachable, and a connector
 * reading the global changes feed gets no other signal: its subsequent
 * `listChanges` and watch calls keep succeeding, so the stale content would
 * stay active indefinitely. The caller answers this by requesting a selection
 * snapshot, which retires whatever is no longer reachable.
 *
 * Deliberately not keyed on `changeType === "drive"`: the legacy "teamDrive"
 * value and any future scope Google introduces must take this path too. What
 * identifies the case is "removed, and not about a specific file" — which is
 * exactly the state the caller has already established.
 */
export function isDriveRemovalChange(change: DriveChangeIdentity): boolean {
  if (isFileScopedDriveChange(change)) return false;
  return change.removed === true;
}
