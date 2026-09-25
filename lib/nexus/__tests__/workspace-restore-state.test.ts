/**
 * @jest-environment node
 *
 * #1791: while a reopened conversation's panel is still restoring, requests ask
 * the server for the persisted binding. The flag must be per-conversation and
 * must clear, or a person who closed the panel would get it bound again.
 */

import { describe, it, expect } from "@jest/globals";
import {
  isWorkspaceRestorePending,
  markWorkspaceRestorePending,
  settleWorkspaceRestore,
} from "../workspace-restore-state";

describe("workspace restore state", () => {
  it("is pending only for the conversation being restored, until settled", () => {
    markWorkspaceRestorePending("conv-1");
    expect(isWorkspaceRestorePending("conv-1")).toBe(true);
    expect(isWorkspaceRestorePending("conv-2")).toBe(false);
    expect(isWorkspaceRestorePending(null)).toBe(false);

    settleWorkspaceRestore("conv-1");
    expect(isWorkspaceRestorePending("conv-1")).toBe(false);
  });

  it("a stale settle for another conversation does not clear the current one", () => {
    markWorkspaceRestorePending("conv-2");
    settleWorkspaceRestore("conv-1");
    expect(isWorkspaceRestorePending("conv-2")).toBe(true);
    settleWorkspaceRestore("conv-2");
  });
});
