/**
 * The workspace panel and canvas refetch when a chat tool changes the open
 * object (#1749 addendum A).
 *
 * Before this, `ArtifactCanvas` fetched versions and head code only on mount and
 * `WorkspacePanel` loaded its payload once per idOrSlug — and that payload is
 * where the pinned `dataAccess` comes from. So the chat wrote a new version,
 * flipped the mode, said "done", and the panel kept rendering the OLD version
 * under the OLD pinned mode until the user reloaded the page. For a query-mode
 * dashboard that reads to the user as "I don't see any data".
 *
 * The signal is a `window` CustomEvent rather than shared state because the panel
 * is a pure layout sibling of the Nexus conversation tree and must never touch
 * the conversation runtime.
 *
 * ONE refresh owner: only `WorkspacePanel` subscribes to the event. It refetches
 * its own payload first and then bumps the canvas's `refreshSignal` prop, so the
 * new code and the `dataAccess` mode it was written for can never land out of
 * order (and a failed panel fetch can never leave new code pinned to the old
 * mode, which two independent subscribers allowed).
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { ArtifactCanvas } from "@/components/atrium/ArtifactCanvas";
import { WorkspacePanel } from "@/components/atrium/WorkspacePanel";
import { emitWorkspaceChanged } from "@/lib/atrium/workspace-change-event";

const getCodeMock = jest.fn();
const listVersionsMock = jest.fn();
const loadPanelMock = jest.fn();

jest.mock("@/actions/db/atrium/get-artifact-code", () => ({
  getArtifactCodeAction: (...a: unknown[]) => getCodeMock(...a),
}));
jest.mock("@/actions/db/atrium/list-versions", () => ({
  listVersionsAction: (...a: unknown[]) => listVersionsMock(...a),
}));
jest.mock("@/actions/db/atrium/create-version", () => ({
  createVersionAction: jest.fn(),
}));
jest.mock("@/actions/db/atrium/rollback-version", () => ({
  rollbackVersionAction: jest.fn(),
}));
jest.mock("@/actions/db/atrium/workspace-panel", () => ({
  loadWorkspacePanelAction: (...a: unknown[]) => loadPanelMock(...a),
}));
jest.mock("@/components/atrium/ArtifactSandbox", () => ({
  ArtifactSandbox: (props: Record<string, unknown>) => (
    <div data-testid="sandbox" data-data-access={String(props.dataAccess ?? "absent")} />
  ),
}));
jest.mock("@/components/atrium/CodeEditor", () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));
jest.mock("@/components/atrium/DocumentEditor", () => ({
  DocumentEditor: () => <div data-testid="document-editor" />,
}));

// lucide-react ships ESM icons jest can't load, and next/link's default export
// resolves undefined under this transform (same stubs as
// tests/unit/atrium-workspace-panel.test.tsx).
jest.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x" />,
  ExternalLink: () => <span data-testid="icon-external" />,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const panelPayload = (dataAccess: string, id = "obj-1", title = "My Dashboard") => ({
  isSuccess: true,
  data: {
    id,
    title,
    kind: "artifact",
    canEdit: true,
    sandboxSrc: "https://sandbox.example.test/render",
    dataAccess,
    userId: 7,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  getCodeMock.mockResolvedValue({
    isSuccess: true,
    data: {
      objectId: "obj-1",
      versionId: "ver-1",
      code: "<p>v1</p>",
      bodyFormat: "html",
    },
  });
  listVersionsMock.mockResolvedValue({
    isSuccess: true,
    data: [{ id: "ver-1", versionNumber: 1, isCurrent: true, authorActor: "human" }],
  });
  loadPanelMock.mockResolvedValue(panelPayload("records"));
});

/** Fire the signal and let the resulting fetches settle. */
async function emitAndSettle(detail: { objectId?: string } = {}) {
  await act(async () => {
    emitWorkspaceChanged(detail);
    await Promise.resolve();
  });
}

describe("ArtifactCanvas reloads on its owner's refreshSignal", () => {
  it("reloads the version list and the new head when the signal changes", async () => {
    const { rerender } = render(
      <ArtifactCanvas
        idOrSlug="obj-1"
        canEdit
        sandboxSrc="https://sandbox.example.test/render"
        refreshSignal={0}
      />
    );
    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(1));
    expect(listVersionsMock).toHaveBeenCalledTimes(1);

    // The chat saved v2; the canvas must pick it up with no page reload.
    getCodeMock.mockResolvedValue({
      isSuccess: true,
      data: {
        objectId: "obj-1",
        versionId: "ver-2",
        code: "<p>v2</p>",
        bodyFormat: "html",
      },
    });
    await act(async () => {
      rerender(
        <ArtifactCanvas
          idOrSlug="obj-1"
          canEdit
          sandboxSrc="https://sandbox.example.test/render"
          refreshSignal={1}
        />
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(2));
    expect(listVersionsMock).toHaveBeenCalledTimes(2);
    // `null` = load the HEAD, the same call the mount effect makes.
    expect(getCodeMock).toHaveBeenLastCalledWith("obj-1", undefined);
  });

  it("does NOT refetch when re-rendered with an unchanged signal", async () => {
    const { rerender } = render(
      <ArtifactCanvas idOrSlug="obj-1" canEdit sandboxSrc="https://s.test/render" refreshSignal={3} />
    );
    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender(
        <ArtifactCanvas idOrSlug="obj-1" canEdit sandboxSrc="https://s.test/render" refreshSignal={3} />
      );
      await Promise.resolve();
    });

    // The mount-time value must never fire: the mount effect is already loading.
    expect(getCodeMock).toHaveBeenCalledTimes(1);
    expect(listVersionsMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT subscribe to the event itself (the panel owns the refresh)", async () => {
    render(
      <ArtifactCanvas idOrSlug="obj-1" canEdit sandboxSrc="https://s.test/render" refreshSignal={0} />
    );
    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(1));

    await emitAndSettle({ objectId: "obj-1" });

    // A second subscriber here is exactly the race this design removed: it would
    // fetch code in parallel with the panel's own fetch of the mode pin.
    expect(getCodeMock).toHaveBeenCalledTimes(1);
    expect(listVersionsMock).toHaveBeenCalledTimes(1);
  });
});

describe("ArtifactCanvas stages the data-access pin with the code", () => {
  const canvas = (dataAccess: string, refreshSignal: number) => (
    <ArtifactCanvas
      idOrSlug="obj-1"
      canEdit
      sandboxSrc="https://s.test/render"
      dataBridgeEnabled={true}
      contentId="obj-1"
      dataAccess={dataAccess as "records" | "query" | "none"}
      refreshSignal={refreshSignal}
    />
  );

  it("keeps the OLD mode until the new code has loaded", async () => {
    const { rerender } = render(canvas("records", 0));
    await waitFor(() =>
      expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("records")
    );

    // The chat saved new query-mode code; the panel refetched and now hands down
    // BOTH the new mode and a bumped signal in one commit.
    let releaseCode: (v: unknown) => void = () => {};
    getCodeMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseCode = resolve;
      })
    );
    await act(async () => {
      rerender(canvas("query", 1));
      await Promise.resolve();
    });

    // The frame key contains the mode: adopting it now would remount the OLD
    // code under the NEW bridge capability for the length of the fetch.
    expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("records");

    await act(async () => {
      releaseCode({
        isSuccess: true,
        data: { objectId: "obj-1", versionId: "ver-2", code: "<p>v2</p>", bodyFormat: "html" },
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("query")
    );
  });

  it("keeps the old mode AND the working preview when the reload fails", async () => {
    const { rerender } = render(canvas("records", 0));
    await waitFor(() => expect(screen.getByTestId("sandbox")).toBeInTheDocument());

    getCodeMock.mockResolvedValueOnce({ isSuccess: false, message: "boom" });
    await act(async () => {
      rerender(canvas("query", 1));
      await Promise.resolve();
    });

    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(2));
    // A background refetch that hiccuped must never blank a working preview, and
    // the pin stays on the mode the rendered version was authored for.
    expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("records");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("applies a mode change that arrives WITHOUT a refresh (Content settings)", async () => {
    const { rerender } = render(canvas("records", 0));
    await waitFor(() =>
      expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("records")
    );

    // `router.refresh()` after a Content-settings flip re-renders this instance
    // with a new mode and no new code — #1712 requires it to apply at once.
    await act(async () => {
      rerender(canvas("query", 0));
      await Promise.resolve();
    });

    expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("query");
    // ...and no reload was triggered: the signal did not change.
    expect(getCodeMock).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspacePanel refetches on atrium:workspace-changed", () => {
  it("re-runs the panel loader so a changed dataAccess reaches the canvas", async () => {
    render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("sandbox")).toBeInTheDocument());
    expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("records");
    expect(loadPanelMock).toHaveBeenCalledTimes(1);
    const codeCallsAtMount = getCodeMock.mock.calls.length;

    // The chat flipped the artifact to live-data mode in the same tool call.
    loadPanelMock.mockResolvedValue(panelPayload("query"));
    await emitAndSettle({ objectId: "obj-1" });

    await waitFor(() =>
      expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("query")
    );
    expect(loadPanelMock).toHaveBeenCalledTimes(2);
    // ...and the canvas reloaded through the signal the panel bumped, so the new
    // code and the new mode arrive together.
    await waitFor(() => expect(getCodeMock.mock.calls.length).toBeGreaterThan(codeCallsAtMount));
  });

  it("keeps the rendered payload when the refresh fails (never blanks a working panel)", async () => {
    render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("sandbox")).toBeInTheDocument());
    const codeCallsAtMount = getCodeMock.mock.calls.length;

    loadPanelMock.mockResolvedValue({ isSuccess: false, message: "boom" });
    await emitAndSettle({ objectId: "obj-1" });

    await waitFor(() => expect(loadPanelMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("sandbox")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The canvas must NOT reload on a failed panel refresh: new code pinned to a
    // stale mode is the mixed state this ordering exists to prevent.
    expect(getCodeMock.mock.calls.length).toBe(codeCallsAtMount);
  });

  it("ignores an event for a DIFFERENT object", async () => {
    render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(loadPanelMock).toHaveBeenCalledTimes(1));

    await emitAndSettle({ objectId: "some-other-object" });

    expect(loadPanelMock).toHaveBeenCalledTimes(1);
  });

  it("drops a refresh that resolves after the panel switched objects", async () => {
    const { rerender } = render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("My Dashboard")).toBeInTheDocument());

    // A refresh for obj-1 starts and hangs.
    let releaseStaleRefresh: (v: unknown) => void = () => {};
    loadPanelMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseStaleRefresh = resolve;
      })
    );
    await emitAndSettle({ objectId: "obj-1" });

    // The user switches the panel to another object, which loads normally.
    loadPanelMock.mockResolvedValue(panelPayload("none", "obj-2", "Other Artifact"));
    await act(async () => {
      rerender(<WorkspacePanel idOrSlug="obj-2" onClose={() => {}} />);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("Other Artifact")).toBeInTheDocument());

    // The stale obj-1 refresh finally lands — it must not overwrite obj-2.
    await act(async () => {
      releaseStaleRefresh(panelPayload("records", "obj-1", "My Dashboard STALE"));
      await Promise.resolve();
    });

    expect(screen.queryByText("My Dashboard STALE")).not.toBeInTheDocument();
    expect(screen.getByText("Other Artifact")).toBeInTheDocument();
  });
});
