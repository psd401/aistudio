"use client";

/**
 * Turn a completed WORKSPACE tool call into the `atrium:workspace-changed` signal
 * (#1749) so the workspace panel beside the chat refetches.
 *
 * Mounted from `ToolGroup`, which assistant-ui wraps around EVERY tool-call part
 * ("Always groups tool calls and reasoning parts, even if there's only one" —
 * `groupMessageParts` in @assistant-ui/core) and which renders its own card
 * header whether or not the card is expanded.
 *
 * It must NOT live in the tool-call renderer (`ConnectorToolFallback`): both
 * `GenericToolCard` and `ConnectorToolCard` render `children` only while
 * `isExpanded`, and the card starts collapsed. A workspace tool call therefore
 * never mounts its renderer while it is running, and expanding the card after the
 * fact hands the hook an already-resolved result — which the history-replay guard
 * below deliberately suppresses. The result was no event at all in the default
 * flow, which is the one thing this feature exists to do (PR #1760, Codex P1).
 *
 * A DOM event rather than shared state because `WorkspacePanel` is a pure layout
 * sibling of the conversation tree and must never touch the conversation runtime
 * (see `docs/features/nexus-conversation-architecture.md`).
 *
 * Fires ONCE per tool call, and only for a call this hook watched go from
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

/** The tool-call part fields this hook reads. */
interface ToolCallLike {
  toolName?: unknown;
  toolCallId?: unknown;
  result?: unknown;
}

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

/** A mutating workspace tool call with a usable identity, or null. */
function workspaceCallOf(part: unknown): { id: string; result: unknown } | null {
  if (typeof part !== "object" || part === null) return null;
  const { toolName, toolCallId, result } = part as ToolCallLike;
  if (typeof toolName !== "string" || !WORKSPACE_MUTATING_TOOLS.has(toolName)) return null;
  // Without a call id the fire-once guards cannot be scoped to one call, and a
  // re-render would re-emit. Every AI SDK tool-call part carries one.
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return null;
  return { id: toolCallId, result };
}

/**
 * Watch a tool group's parts and emit `atrium:workspace-changed` for each
 * mutating workspace call that resolves successfully under observation.
 *
 * State is keyed by `toolCallId` rather than held per component instance, so one
 * group containing several workspace edits signals each of them exactly once.
 */
export function useWorkspaceChangeSignals(parts: readonly unknown[]): void {
  // Calls observed WITHOUT a result — i.e. watched running live, rather than
  // arriving already-complete from conversation history.
  const sawPendingRef = useRef<Set<string>>(new Set());
  const emittedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const part of parts) {
      const call = workspaceCallOf(part);
      if (!call) continue;
      if (!isResolved(call.result)) {
        sawPendingRef.current.add(call.id);
        continue;
      }
      if (!sawPendingRef.current.has(call.id) || emittedRef.current.has(call.id)) continue;
      // An error result changed nothing — refetching would only flicker the panel.
      if (typeof call.result === "object" && call.result !== null && "error" in call.result) {
        continue;
      }
      emittedRef.current.add(call.id);
      emitWorkspaceChanged({ objectId: objectIdOf(call.result) });
    }
  }, [parts]);
}
