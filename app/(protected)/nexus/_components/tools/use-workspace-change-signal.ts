"use client";

/**
 * Turn a completed WORKSPACE tool call into the `atrium:workspace-changed` signal
 * (#1749) so the workspace panel beside the chat refetches.
 *
 * Mounted from the Nexus tool-call renderer (`ConnectorToolFallback`), which is
 * the single `toolFallback` every workspace tool call renders through — so the
 * signal does not depend on assistant-ui's grouping heuristics. It is a DOM event
 * rather than shared state because `WorkspacePanel` is a pure layout sibling of
 * the conversation tree and must never touch the conversation runtime (see
 * `docs/features/nexus-conversation-architecture.md`).
 *
 * Fires ONCE per tool call, and only for a call this component watched go from
 * "running" to "resolved". A conversation reloaded from history renders its tool
 * parts with the result already present, which is NOT a change to react to — the
 * pending-first guard keeps a reload from firing a burst of spurious refetches.
 */

import { useEffect, useRef } from "react";
import { emitWorkspaceChanged } from "@/lib/atrium/workspace-change-event";

/**
 * The workspace tools whose results mutate what the panel renders. Read-only
 * tools (`read_workspace_content`, `find_atrium_documents`) are absent, and so is
 * `edit_atrium_document`: it edits a DIFFERENT document than the open one, and
 * its live Yjs write already lands in any editor that has it open.
 */
const WORKSPACE_MUTATING_TOOLS = new Set([
  "update_workspace_artifact",
  "edit_workspace_document",
  "publish_workspace_content",
  "unpublish_workspace_content",
]);

/** Pull the object id off a tool result, when it carried one. */
function objectIdOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as { objectId?: unknown }).objectId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A tool result is "resolved" once it is neither `undefined` (still streaming)
 * nor `null` (stream error before onFinish — the result was never captured).
 * Mirrors the running-state test in `tool-group.tsx`.
 */
function isResolved(result: unknown): boolean {
  return result !== undefined && result !== null;
}

export function useWorkspaceChangeSignal(
  toolName: string,
  result: unknown,
  /**
   * The part's `toolCallId`. Scopes the fire-once guards to ONE call: if the
   * renderer ever reuses this component instance for a different tool call
   * (index-based reconciliation rather than a stable per-call key), the second
   * call would otherwise inherit `emittedRef` from the first and never signal.
   */
  toolCallId?: string
): void {
  // Whether this call was ever observed WITHOUT a result — i.e. we watched it run
  // live, rather than arriving already-complete from conversation history.
  const sawPendingRef = useRef(false);
  const emittedRef = useRef(false);
  const callIdRef = useRef(toolCallId);

  useEffect(() => {
    if (!WORKSPACE_MUTATING_TOOLS.has(toolName)) return;
    if (callIdRef.current !== toolCallId) {
      callIdRef.current = toolCallId;
      sawPendingRef.current = false;
      emittedRef.current = false;
    }
    if (!isResolved(result)) {
      sawPendingRef.current = true;
      return;
    }
    if (!sawPendingRef.current || emittedRef.current) return;
    // An error result changed nothing — refetching would only flicker the panel.
    if (typeof result === "object" && result !== null && "error" in result) return;
    emittedRef.current = true;
    emitWorkspaceChanged({ objectId: objectIdOf(result) });
  }, [toolName, result, toolCallId]);
}
