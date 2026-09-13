/**
 * The tool-result → `atrium:workspace-changed` signal (#1749 addendum A).
 *
 * Mounted in `ToolGroup` — NOT in the tool-call renderer, which mounts only
 * while the tool card is expanded and so never observes a call running (PR #1760,
 * Codex P1). Its contract is narrow and easy to get wrong in ways that are
 * invisible until a user hits them:
 *  - only the four MUTATING workspace tools fire it (a read must not);
 *  - it fires ONCE per call, not on every re-render;
 *  - a conversation reloaded from history renders its tool parts with the result
 *    already present — that is not a change, and must not fire a burst of
 *    refetches on every page load;
 *  - an error result changed nothing, so it must not fire either;
 *  - a group carrying several workspace calls signals each of them once.
 */

import { renderHook } from "@testing-library/react";
import { useWorkspaceChangeSignals } from "@/app/(protected)/nexus/_components/tools/use-workspace-change-signal";
import { WORKSPACE_CHANGED_EVENT } from "@/lib/atrium/workspace-change-event";

let fired: Array<{ objectId?: string }>;
let listener: (event: Event) => void;

beforeEach(() => {
  fired = [];
  listener = (event: Event) => {
    fired.push((event as CustomEvent<{ objectId?: string }>).detail);
  };
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
});

afterEach(() => {
  window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
});

/** One tool-call part, as `ToolGroup` reads them off the message. */
const part = (toolName: string, result: unknown, toolCallId = "call-1") => ({
  type: "tool-call",
  toolName,
  toolCallId,
  result,
});

/** Render the hook as a streaming call would: pending first, then resolved. */
function renderStreamed(toolName: string, result: unknown, toolCallId = "call-1") {
  const view = renderHook(
    ({ parts }: { parts: readonly unknown[] }) => useWorkspaceChangeSignals(parts),
    { initialProps: { parts: [part(toolName, undefined, toolCallId)] as readonly unknown[] } }
  );
  view.rerender({ parts: [part(toolName, result, toolCallId)] });
  return view;
}

describe("useWorkspaceChangeSignals", () => {
  it("fires once with the objectId when an artifact update resolves", () => {
    renderStreamed("update_workspace_artifact", {
      ok: true,
      objectId: "obj-1",
      versionNumber: 2,
    });
    expect(fired).toEqual([{ objectId: "obj-1" }]);
  });

  it("does not fire again on a re-render of the same resolved call", () => {
    const view = renderStreamed("update_workspace_artifact", { ok: true, objectId: "obj-1" });
    view.rerender({ parts: [part("update_workspace_artifact", { ok: true, objectId: "obj-1" })] });
    expect(fired).toHaveLength(1);
  });

  it("fires again for a DIFFERENT toolCallId in the same group", () => {
    // A second workspace edit in the same assistant turn joins the SAME tool
    // group, so the hook instance is reused. Guards are keyed by call id, or the
    // second edit would never refresh the panel.
    const view = renderStreamed("update_workspace_artifact", { ok: true, objectId: "obj-1" });
    expect(fired).toHaveLength(1);
    view.rerender({
      parts: [
        part("update_workspace_artifact", { ok: true, objectId: "obj-1" }),
        part("update_workspace_artifact", undefined, "call-2"),
      ],
    });
    view.rerender({
      parts: [
        part("update_workspace_artifact", { ok: true, objectId: "obj-1" }),
        part("update_workspace_artifact", { ok: true, objectId: "obj-1", versionNumber: 3 }, "call-2"),
      ],
    });
    expect(fired).toEqual([{ objectId: "obj-1" }, { objectId: "obj-1" }]);
  });

  it("does NOT fire for a call that arrived already-resolved (history replay)", () => {
    renderHook(() =>
      useWorkspaceChangeSignals([
        part("update_workspace_artifact", { ok: true, objectId: "obj-1" }),
      ])
    );
    expect(fired).toEqual([]);
  });

  it("does NOT fire for an error result (nothing changed)", () => {
    renderStreamed("update_workspace_artifact", { error: "conflict" });
    expect(fired).toEqual([]);
  });

  it("does NOT fire for read-only or unrelated tools", () => {
    renderStreamed("read_workspace_content", { title: "x", body: "y" });
    renderStreamed("edit_atrium_document", { ok: true, objectId: "other-doc" });
    renderStreamed("show_chart", { ok: true });
    expect(fired).toEqual([]);
  });

  it("fires for the document-edit and publish/unpublish tools", () => {
    renderStreamed("edit_workspace_document", { ok: true, objectId: "doc-9", mode: "append" });
    renderStreamed("publish_workspace_content", { ok: true, objectId: "obj-2", published: true });
    renderStreamed("unpublish_workspace_content", { ok: true, objectId: "obj-2" });
    expect(fired).toEqual([
      // Every mutating tool result carries the id it changed, so the event is
      // always scoped — an id-less event matches EVERY listener, which would
      // refresh a panel the user switched to mid-stream.
      { objectId: "doc-9" },
      { objectId: "obj-2" },
      { objectId: "obj-2" },
    ]);
  });

  it("treats a null result as still running (stream error before onFinish)", () => {
    renderStreamed("update_workspace_artifact", null);
    expect(fired).toEqual([]);
  });

  it("ignores a part with no usable call id", () => {
    const view = renderHook(
      ({ parts }: { parts: readonly unknown[] }) => useWorkspaceChangeSignals(parts),
      {
        initialProps: {
          parts: [
            { type: "tool-call", toolName: "update_workspace_artifact", result: undefined },
          ] as readonly unknown[],
        },
      }
    );
    view.rerender({
      parts: [
        { type: "tool-call", toolName: "update_workspace_artifact", result: { ok: true, objectId: "obj-1" } },
      ],
    });
    // Without an id the fire-once guard cannot be scoped, so re-renders would
    // re-emit; skipping is the safe read of a shape that should never occur.
    expect(fired).toEqual([]);
  });
});
