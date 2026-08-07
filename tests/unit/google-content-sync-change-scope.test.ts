/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import {
  DRIVE_SCOPED_CHANGE_TYPE,
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

  test("the reconcile loop persists the cursor for skipped entries", () => {
    const loop = source.slice(
      source.indexOf("async function reconcileChanges("),
    );
    // processGoogleDriveChange returns false for a skipped entry, which leaves
    // requiresSelectionSnapshot false, so persistSyncCursor runs each page.
    expect(loop).toContain("if (!requiresSelectionSnapshot) {");
    expect(loop).toContain("await persistSyncCursor(");
  });
});
