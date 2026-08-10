/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import {
  DRIVE_SCOPED_CHANGE_TYPE,
  isDriveRemovalChange,
  isFileScopedDriveChange,
} from "../../infra/lambdas/google-content-sync/changes";
import { stripComments } from "../helpers/strip-ts-comments";

describe("Google Drive change scope classification", () => {
  test("skips Shared Drive-scoped entries even when a fileId is present", () => {
    expect(
      isFileScopedDriveChange({ changeType: DRIVE_SCOPED_CHANGE_TYPE }),
    ).toBe(false);
    expect(
      isFileScopedDriveChange({
        changeType: DRIVE_SCOPED_CHANGE_TYPE,
        fileId: "file-1",
      }),
    ).toBe(false);
  });

  test("skips entries with a missing or empty fileId", () => {
    expect(isFileScopedDriveChange({})).toBe(false);
    expect(isFileScopedDriveChange({ changeType: "file" })).toBe(false);
    expect(isFileScopedDriveChange({ fileId: "" })).toBe(false);
    expect(isFileScopedDriveChange({ fileId: undefined })).toBe(false);
  });

  test("processes file-scoped entries, including ones with no changeType", () => {
    expect(isFileScopedDriveChange({ changeType: "file", fileId: "f1" })).toBe(
      true,
    );
    expect(isFileScopedDriveChange({ fileId: "f1" })).toBe(true);
  });

  test("treats unknown change types as file-scoped when a fileId is present", () => {
    // A future changeType value must not become a poison message: if Google
    // gave us a fileId, the file path can still act on it.
    expect(
      isFileScopedDriveChange({ changeType: "someFutureScope", fileId: "f1" }),
    ).toBe(true);
    expect(isFileScopedDriveChange({ changeType: "someFutureScope" })).toBe(
      false,
    );
  });

  test("narrows fileId to a string for the file-scoped branch", () => {
    const change: { changeType?: string; fileId?: string } = {
      changeType: "file",
      fileId: "file-1",
    };
    if (isFileScopedDriveChange(change)) {
      const fileId: string = change.fileId;
      expect(fileId).toBe("file-1");
    } else {
      throw new Error("expected the entry to be file-scoped");
    }
  });
});

describe("Shared Drive removal detection", () => {
  test("flags a drive-scoped removal so the caller rebuilds the selection", () => {
    // The Shared Drive was deleted or access was lost. Sources imported from
    // it are unreachable, and a connector reading the global changes feed gets
    // no other signal — its later listChanges calls keep succeeding.
    expect(
      isDriveRemovalChange({
        changeType: DRIVE_SCOPED_CHANGE_TYPE,
        removed: true,
      }),
    ).toBe(true);
  });

  test("covers legacy and future drive-like scopes, not just \"drive\"", () => {
    expect(
      isDriveRemovalChange({ changeType: "teamDrive", removed: true }),
    ).toBe(true);
    expect(
      isDriveRemovalChange({ changeType: "someFutureScope", removed: true }),
    ).toBe(true);
    expect(isDriveRemovalChange({ removed: true })).toBe(true);
  });

  test("ignores drive-scoped metadata noise", () => {
    // Rename, membership and restriction changes carry removed: false.
    expect(
      isDriveRemovalChange({
        changeType: DRIVE_SCOPED_CHANGE_TYPE,
        removed: false,
      }),
    ).toBe(false);
    expect(
      isDriveRemovalChange({ changeType: DRIVE_SCOPED_CHANGE_TYPE }),
    ).toBe(false);
  });

  test("never claims a file-scoped removal — that is the file path's job", () => {
    expect(
      isDriveRemovalChange({
        changeType: "file",
        fileId: "file-1",
        removed: true,
      }),
    ).toBe(false);
  });

  test("treats a drive-scoped entry that also carries a fileId as drive-scoped", () => {
    expect(
      isDriveRemovalChange({
        changeType: DRIVE_SCOPED_CHANGE_TYPE,
        fileId: "file-1",
        removed: true,
      }),
    ).toBe(true);
  });
});

describe("processGoogleDriveChange guard wiring", () => {
  const source = stripComments(
    fs.readFileSync(
      path.join(process.cwd(), "infra/lambdas/google-content-sync/index.ts"),
      "utf8",
    ),
  );

  test("guards the change handler before any file-scoped work", () => {
    const body = source.slice(
      source.indexOf("async function processGoogleDriveChange("),
    );
    const guardIndex = body.indexOf("isFileScopedDriveChange(change)");
    const firstSideEffect = body.indexOf("markSourceMissing(");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(firstSideEffect).toBeGreaterThan(-1);
    // The skip must come first: nothing downstream can act on a fileId-less
    // entry, and the reconcile loop still advances the cursor afterwards.
    expect(guardIndex).toBeLessThan(firstSideEffect);
  });

  test("propagates the removal signal instead of swallowing it", () => {
    const body = source.slice(
      source.indexOf("async function processGoogleDriveChange("),
    );
    // A drive removal must return true so reconcileChanges rebuilds the
    // selection snapshot; returning a bare false here would strand every
    // source imported from the drive that went away.
    expect(body).toContain("isDriveRemovalChange(change)");
    expect(body).toContain("return driveRemoved;");
  });

  test("the reconcile loop is the shared, behaviorally tested one", () => {
    // The cursor/obligation ordering itself is proven in
    // google-content-sync-reconcile.test.ts against the real loop. All this
    // asserts is that index.ts still delegates to it rather than growing a
    // second copy.
    const loop = source.slice(
      source.indexOf("async function reconcileChanges("),
      source.indexOf("async function markConnectorAccessLost("),
    );
    expect(loop).toContain("return reconcileChangePages<GoogleDriveChange>(");
    expect(loop).toContain("runSelectionSnapshot:");
    expect(loop).toContain("markSnapshotPending:");
  });

  test("an unreadable file record fails the one change, never the page", () => {
    const body = source.slice(
      source.indexOf("async function recordDriveChangeFailure("),
      source.indexOf("async function processGoogleDriveChange("),
    );
    const unreadable = body.indexOf("GoogleDriveUnreadableFileError");
    const rethrow = body.indexOf(
      "if (!isGoogleDriveMissingError(error)) throw error;",
    );

    // The unreadable branch must be classified before the catch-all rethrow —
    // a ZodError from getFile that escapes this function replays the page
    // until the DLQ, the poison pattern this Lambda exists to avoid — and it
    // must fail the record, never reinterpret it as a removal.
    expect(unreadable).toBeGreaterThan(-1);
    expect(rethrow).toBeGreaterThan(-1);
    expect(unreadable).toBeLessThan(rethrow);
    expect(body).toContain("recordSourceFailure(context, fileId, error)");
  });

  test("a shortcut with no target fails typed, so it cannot poison a page", () => {
    const body = source.slice(
      source.indexOf("async function resolveShortcut("),
      source.indexOf("type AddDiscoveredFile ="),
    );

    // `shortcutDetails.targetId` is optional in the schema — a shortcut whose
    // target was deleted is a real Drive state — so this branch is reachable
    // on a well-formed page. A bare `Error` here falls through every
    // classification branch: `add()` rethrows it and aborts the whole
    // selection snapshot, and `recordDriveChangeFailure` rethrows it before
    // reconcileChangePages persists the page cursor. That is the poison-page
    // failure this Lambda exists to prevent, relocated from Zod validation to
    // shortcut resolution.
    expect(body).toContain("new GoogleDriveUnreadableFileError(");
    expect(body).not.toContain("throw new Error(");
  });

  test("a removed drive selection is retired scoped, not connector-wide", () => {
    const body = source.slice(
      source.indexOf("async function enumerateInitialFiles("),
      source.indexOf("async function selectedViaForFile("),
    );
    const missingBranch = body.indexOf("isGoogleDriveMissingError(error)");

    expect(missingBranch).toBeGreaterThan(-1);
    expect(body).toContain("inaccessibleSelectionCount += 1");
    // The branch must NOT be gated on selectionKind. Rethrowing for `drive`
    // selections escalated one removed Shared Drive into
    // markConnectorAccessLost, which marks every source on the connector —
    // including still-readable file and folder selections — and the deletion
    // grace period then removes their content. Continuing lets
    // markUnseenSourcesMissing retire only what this enumeration did not see.
    expect(body).not.toContain('selection.selectionKind !== "drive"');
  });

  test("an incomplete initial rebuild leaves a durable snapshot obligation", () => {
    const body = source.slice(
      source.indexOf("async function reconcileInitial("),
      source.indexOf("async function retryDeferredDownloads("),
    );
    // Without this, files hidden behind a dropped entry during the very first
    // enumeration (or a 410 rebuild) are only recovered if they happen to
    // change again — the changes-loop path already retries its obligation.
    expect(body).toContain("setSelectionSnapshotPending(context, !complete)");
  });
});
