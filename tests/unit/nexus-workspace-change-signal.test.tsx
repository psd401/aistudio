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
function renderStreamed(toolName: string, result: unknown) {
  const view = renderHook(
    ({ name, res }: { name: string; res: unknown }) => useWorkspaceChangeSignal(name, res),
    { initialProps: { name: toolName, res: undefined as unknown } }
  );
  view.rerender({ name: toolName, res: result });
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
    view.rerender({ name: "update_workspace_artifact", res: { ok: true, objectId: "obj-1" } });
    expect(fired).toHaveLength(1);
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
    renderStreamed("edit_workspace_document", { ok: true, mode: "append" });
    renderStreamed("publish_workspace_content", { ok: true, objectId: "obj-2", published: true });
    renderStreamed("unpublish_workspace_content", { ok: true, objectId: "obj-2" });
    expect(fired).toEqual([
      // No objectId on the shared doc-edit result — listeners then refresh
      // unconditionally, which is correct: the tool is bound to the open object.
      { objectId: undefined },
      { objectId: "obj-2" },
      { objectId: "obj-2" },
    ]);
  });

  it("treats a null result as still running (stream error before onFinish)", () => {
    renderStreamed("update_workspace_artifact", null);
    expect(fired).toEqual([]);
  });
});
