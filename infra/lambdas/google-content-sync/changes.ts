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
