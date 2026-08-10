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

  test("the reconcile loop persists the cursor on both skip and removal", () => {
    const loop = source.slice(
      source.indexOf("async function reconcileChanges("),
      source.indexOf("async function markConnectorAccessLost("),
    );
    // Skipped entry: returns false, requiresSelectionSnapshot stays false, so
    // the per-page persist runs.
    expect(loop).toContain("if (!requiresSelectionSnapshot) {");
    // Removal: returns true, so the cursor is persisted after the snapshot.
    expect(loop).toContain("if (requiresSelectionSnapshot) {");
    expect(loop).toContain("await reconcileSelectionSnapshot(");
    // Either way the cursor advances — that is the invariant the outage broke.
    expect(loop.match(/await persistSyncCursor\(/g)).toHaveLength(2);
  });
});
