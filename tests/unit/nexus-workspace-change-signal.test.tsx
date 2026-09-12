/**
 * The tool-result → `atrium:workspace-changed` signal (#1749 addendum A).
 *
 * Mounted in the Nexus tool-call renderer. Its contract is narrow and easy to get
 * wrong in ways that are invisible until a user hits them:
 *  - only the four MUTATING workspace tools fire it (a read must not);
 *  - it fires ONCE per call, not on every re-render;
 *  - a conversation reloaded from history renders its tool parts with the result
 *    already present — that is not a change, and must not fire a burst of
 *    refetches on every page load;
 *  - an error result changed nothing, so it must not fire either.
 */

import { renderHook } from "@testing-library/react";
import { useWorkspaceChangeSignal } from "@/app/(protected)/nexus/_components/tools/use-workspace-change-signal";
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

/** Render the hook as a streaming call would: pending first, then resolved. */
function renderStreamed(toolName: string, result: unknown, toolCallId = "call-1") {
  const view = renderHook(
    ({ name, res, id }: { name: string; res: unknown; id: string }) =>
      useWorkspaceChangeSignal(name, res, id),
    { initialProps: { name: toolName, res: undefined as unknown, id: toolCallId } }
  );
  view.rerender({ name: toolName, res: result, id: toolCallId });
  return view;
}

describe("useWorkspaceChangeSignal", () => {
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
    view.rerender({
      name: "update_workspace_artifact",
      res: { ok: true, objectId: "obj-1" },
      id: "call-1",
    });
    expect(fired).toHaveLength(1);
  });

  it("fires again for a DIFFERENT toolCallId on the same hook instance", () => {
    // If the renderer reconciles tool parts by index rather than by a stable
    // per-call key, one instance sees two logically different calls. The
    // fire-once guards must reset per call id, or the second edit never
    // refreshes the panel.
    const view = renderStreamed("update_workspace_artifact", { ok: true, objectId: "obj-1" });
    expect(fired).toHaveLength(1);
    // The next call starts pending, then resolves — under a new id.
    view.rerender({ name: "update_workspace_artifact", res: undefined, id: "call-2" });
    view.rerender({
      name: "update_workspace_artifact",
      res: { ok: true, objectId: "obj-1", versionNumber: 3 },
      id: "call-2",
    });
    expect(fired).toEqual([{ objectId: "obj-1" }, { objectId: "obj-1" }]);
  });

  it("does NOT fire for a call that arrived already-resolved (history replay)", () => {
    renderHook(() =>
      useWorkspaceChangeSignal("update_workspace_artifact", { ok: true, objectId: "obj-1" })
    );
    expect(fired).toEqual([]);
  });

  it("does NOT fire for an error result (nothing changed)", () => {
    renderStreamed("update_workspace_artifact", { error: "conflict" });
    expect(fired).toEqual([]);
  });

  it("does NOT fire for read-only or unrelated tools", () => {
    renderStreamed("read_workspace_content", { title: "x", body: "y" });
    renderStreamed("edit_atrium_document", { ok: true });
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
});
