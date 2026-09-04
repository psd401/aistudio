/**
 * Component smoke for the Nexus WorkspacePanel (Epic #1059, spec §17).
 *
 * The panel is a pure layout sibling of the fragile conversation tree, so its
 * contract is small and worth pinning: loads via the canView-gated action, mounts
 * the kind-specific editor with the action's payload, surfaces errors, closes via
 * the callback, and RELOADS only when idOrSlug changes (ID-keyed guard).
 *
 * The heavy editors (TipTap/Yjs, sandbox) are mocked — their internals are covered
 * by their own suites; the panel only routes props to them.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkspacePanel } from "@/components/atrium/WorkspacePanel";

const loadMock = jest.fn();
jest.mock("@/actions/db/atrium/workspace-panel", () => ({
  loadWorkspacePanelAction: (...a: unknown[]) => loadMock(...a),
}));

// lucide-react ships ESM icons jest can't load — stub the two the panel uses
// (established pattern: tests/components/visibility-chip.test.tsx).
jest.mock("lucide-react", () => ({
  X: () => <span data-testid="icon-x" />,
  ExternalLink: () => <span data-testid="icon-external" />,
}));

// next/link's default export resolves undefined under this jest transform — a
// plain anchor preserves the href-assertion surface.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock("@/components/atrium/DocumentEditor", () => ({
  // Echo the `layout` prop too: the panel MUST pass layout="panel" so the editor
  // stacks its comment rail instead of collapsing beside it (Epic #1059 §17).
  DocumentEditor: ({
    idOrSlug,
    userId,
    layout,
  }: {
    idOrSlug: string;
    userId: number;
    layout?: string;
  }) => (
    <div data-testid="doc-editor">{`doc:${idOrSlug}:u${userId}:${layout}`}</div>
  ),
}));
jest.mock("@/components/atrium/ArtifactCanvas", () => ({
  // The bridge props (#1725) are echoed too: "Open beside chat" is where most
  // artifacts are actually built, so a query-mode dashboard has to be
  // exercisable here and not only on the full edit page.
  ArtifactCanvas: ({
    idOrSlug,
    canEdit,
    sandboxSrc,
    dataBridgeEnabled,
    contentId,
    dataAccess,
  }: {
    idOrSlug: string;
    canEdit?: boolean;
    sandboxSrc?: string | null;
    dataBridgeEnabled?: boolean;
    contentId?: string;
    dataAccess?: string;
  }) => (
    <div
      data-testid="artifact-canvas"
      data-bridge-enabled={String(dataBridgeEnabled ?? "absent")}
      data-content-id={String(contentId ?? "absent")}
      data-data-access={String(dataAccess ?? "absent")}
    >{`art:${idOrSlug}:${canEdit}:${sandboxSrc}`}</div>
  ),
}));

const DOC = {
  id: "obj-1",
  slug: "my-doc",
  title: "My Doc",
  kind: "document" as const,
  userId: 7,
  canEdit: true,
  sandboxSrc: null,
  dataAccess: null as string | null,
};

beforeEach(() => {
  loadMock.mockReset();
});

describe("WorkspacePanel", () => {
  it("loads and mounts the DocumentEditor with the action payload", async () => {
    loadMock.mockResolvedValue({ isSuccess: true, data: DOC });
    render(<WorkspacePanel idOrSlug="my-doc" onClose={jest.fn()} />);
    expect(screen.getByText("Loading workspace…")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("doc-editor")).toHaveTextContent("doc:obj-1:u7:panel")
    );
    expect(screen.getByRole("heading", { name: "My Doc" })).toBeInTheDocument();
    expect(loadMock).toHaveBeenCalledWith("my-doc");
  });

  it("mounts the ArtifactCanvas (canEdit + sandboxSrc threaded) for artifacts", async () => {
    loadMock.mockResolvedValue({
      isSuccess: true,
      data: { ...DOC, kind: "artifact", canEdit: false, sandboxSrc: "https://sb/render" },
    });
    render(<WorkspacePanel idOrSlug="obj-1" onClose={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-canvas")).toHaveTextContent(
        "art:obj-1:false:https://sb/render"
      )
    );
  });

  it("enables the data bridge with the action's id and mode pin (#1725)", async () => {
    loadMock.mockResolvedValue({
      isSuccess: true,
      data: {
        ...DOC,
        kind: "artifact",
        sandboxSrc: "https://sb/render",
        dataAccess: "query",
      },
    });
    render(<WorkspacePanel idOrSlug="obj-1" onClose={jest.fn()} />);
    await waitFor(() => {
      const canvas = screen.getByTestId("artifact-canvas");
      expect(canvas).toHaveAttribute("data-bridge-enabled", "true");
      expect(canvas).toHaveAttribute("data-content-id", "obj-1");
      expect(canvas).toHaveAttribute("data-data-access", "query");
    });
  });

  it("falls back to the no-op mode when the payload carries none", async () => {
    // `dataAccess` is null only for documents, which never reach this branch —
    // but the fallback must not widen anything if that ever changes.
    loadMock.mockResolvedValue({
      isSuccess: true,
      data: { ...DOC, kind: "artifact", sandboxSrc: "https://sb/render" },
    });
    render(<WorkspacePanel idOrSlug="obj-1" onClose={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-canvas")).toHaveAttribute(
        "data-data-access",
        "none"
      )
    );
  });

  it("surfaces a load failure as an alert (404-masked upstream)", async () => {
    loadMock.mockResolvedValue({ isSuccess: false, message: "Content not found" });
    render(<WorkspacePanel idOrSlug="missing" onClose={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Content not found")
    );
  });

  it("invokes onClose from the close control", async () => {
    loadMock.mockResolvedValue({ isSuccess: true, data: DOC });
    const onClose = jest.fn();
    render(<WorkspacePanel idOrSlug="my-doc" onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("workspace-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reloads ONLY when idOrSlug changes (ID-keyed guard, not a boolean)", async () => {
    loadMock.mockResolvedValue({ isSuccess: true, data: DOC });
    const { rerender } = render(<WorkspacePanel idOrSlug="my-doc" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toBeInTheDocument());
    expect(loadMock).toHaveBeenCalledTimes(1);

    // Same id re-render → no reload.
    rerender(<WorkspacePanel idOrSlug="my-doc" onClose={jest.fn()} />);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // New id → reload.
    loadMock.mockResolvedValue({
      isSuccess: true,
      data: { ...DOC, id: "obj-2", title: "Other" },
    });
    rerender(<WorkspacePanel idOrSlug="other-doc" onClose={jest.fn()} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));
    expect(loadMock).toHaveBeenLastCalledWith("other-doc");
  });
});
