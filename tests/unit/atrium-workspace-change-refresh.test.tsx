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

const panelPayload = (dataAccess: string) => ({
  isSuccess: true,
  data: {
    id: "obj-1",
    title: "My Dashboard",
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

describe("ArtifactCanvas refetches on atrium:workspace-changed", () => {
  it("reloads the version list and the new head", async () => {
    render(
      <ArtifactCanvas idOrSlug="obj-1" canEdit sandboxSrc="https://sandbox.example.test/render" />
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
    await emitAndSettle({ objectId: "obj-1" });

    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(2));
    expect(listVersionsMock).toHaveBeenCalledTimes(2);
    // `null` = load the HEAD, the same call the mount effect makes.
    expect(getCodeMock).toHaveBeenLastCalledWith("obj-1", undefined);
  });

  it("ignores an event for a DIFFERENT object", async () => {
    render(
      <ArtifactCanvas idOrSlug="obj-1" canEdit sandboxSrc="https://sandbox.example.test/render" />
    );
    await waitFor(() => expect(getCodeMock).toHaveBeenCalledTimes(1));

    await emitAndSettle({ objectId: "some-other-object" });

    expect(getCodeMock).toHaveBeenCalledTimes(1);
    expect(listVersionsMock).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspacePanel refetches on atrium:workspace-changed", () => {
  it("re-runs the panel loader so a changed dataAccess reaches the canvas", async () => {
    render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("sandbox")).toBeInTheDocument());
    expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("records");
    expect(loadPanelMock).toHaveBeenCalledTimes(1);

    // The chat flipped the artifact to live-data mode in the same tool call.
    loadPanelMock.mockResolvedValue(panelPayload("query"));
    await emitAndSettle({ objectId: "obj-1" });

    await waitFor(() =>
      expect(screen.getByTestId("sandbox").getAttribute("data-data-access")).toBe("query")
    );
    expect(loadPanelMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the rendered payload when the refresh fails (never blanks a working panel)", async () => {
    render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("sandbox")).toBeInTheDocument());

    loadPanelMock.mockResolvedValue({ isSuccess: false, message: "boom" });
    await emitAndSettle({ objectId: "obj-1" });

    await waitFor(() => expect(loadPanelMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("sandbox")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an event for a DIFFERENT object", async () => {
    render(<WorkspacePanel idOrSlug="obj-1" onClose={() => {}} />);
    await waitFor(() => expect(loadPanelMock).toHaveBeenCalledTimes(1));

    await emitAndSettle({ objectId: "some-other-object" });

    expect(loadPanelMock).toHaveBeenCalledTimes(1);
  });
});
