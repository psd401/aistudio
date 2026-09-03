/**
 * Unit test for the ArtifactCanvas preview's data-bridge wiring (#1725).
 *
 * The canvas is the OTHER surface whose job is to let an author look at their
 * own unpublished work (`/atrium/[id]/edit` and the Nexus "Open beside chat"
 * panel both mount it). Before #1725 it rendered `<ArtifactSandbox>` with no
 * bridge props, so a query-mode dashboard could not be exercised until after it
 * was published.
 *
 * The contract pinned here:
 *  - bridge props are threaded through VERBATIM when a server-resolved caller
 *    supplies them (id from trusted props, mode pinned per load, #1712);
 *  - a caller that stays silent keeps failing CLOSED — the preview then carries
 *    NO `dataBridgeEnabled` and NO `contentId` at all;
 *  - the sandbox key covers artifact id AND mode, because the loaded-mode pin
 *    lives in a ref for the mount's lifetime and must never outlive either.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { ArtifactCanvas } from "@/components/atrium/ArtifactCanvas";

const getCodeMock = jest.fn();
const listVersionsMock = jest.fn();
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

// The real sandbox mounts a cross-origin iframe; here we only need to observe
// which props reached it, so the stub serializes them into the DOM. `key` is
// deliberately echoed too — it is load-bearing for the #1712 pin, and React
// does not expose it as a prop.
jest.mock("@/components/atrium/ArtifactSandbox", () => ({
  ArtifactSandbox: (props: Record<string, unknown>) => (
    <div
      data-testid="sandbox"
      data-bridge-enabled={String(props.dataBridgeEnabled ?? "absent")}
      data-content-id={String(props.contentId ?? "absent")}
      data-data-access={String(props.dataAccess ?? "absent")}
    />
  ),
}));
jest.mock("@/components/atrium/CodeEditor", () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));

const BASE = {
  idOrSlug: "obj-1",
  canEdit: true,
  sandboxSrc: "https://sandbox.example.test/render",
};

beforeEach(() => {
  jest.clearAllMocks();
  getCodeMock.mockResolvedValue({
    isSuccess: true,
    data: {
      objectId: "obj-1",
      versionId: "ver-1",
      code: "<p>artifact</p>",
      bodyFormat: "html",
    },
  });
  listVersionsMock.mockResolvedValue({
    isSuccess: true,
    data: [{ id: "ver-1", versionNumber: 1, isCurrent: true, authorActor: "human" }],
  });
});

describe("ArtifactCanvas preview data bridge (#1725)", () => {
  it("threads the caller's trusted content id and pinned mode into the sandbox", async () => {
    render(
      <ArtifactCanvas
        {...BASE}
        // Deliberately a SLUG in idOrSlug while contentId is the resolved uuid:
        // the bridge's authority boundary is the server-resolved id, never the
        // route param.
        idOrSlug="device-repair-dashboard"
        dataBridgeEnabled={true}
        contentId="obj-1"
        dataAccess="query"
      />
    );

    const sandbox = await screen.findByTestId("sandbox");
    expect(sandbox).toHaveAttribute("data-bridge-enabled", "true");
    expect(sandbox).toHaveAttribute("data-content-id", "obj-1");
    expect(sandbox).toHaveAttribute("data-data-access", "query");
  });

  it("forwards a records-mode artifact's own mode rather than widening it", async () => {
    render(
      <ArtifactCanvas
        {...BASE}
        dataBridgeEnabled={true}
        contentId="obj-1"
        dataAccess="records"
      />
    );

    const sandbox = await screen.findByTestId("sandbox");
    expect(sandbox).toHaveAttribute("data-data-access", "records");
  });

  it("fails closed for a caller that does not enable the bridge", async () => {
    render(<ArtifactCanvas {...BASE} />);

    const sandbox = await screen.findByTestId("sandbox");
    // Not merely `false`: the props must be ABSENT, so nothing downstream can
    // read a content id off a preview that was never authorized to have one.
    expect(sandbox).toHaveAttribute("data-bridge-enabled", "absent");
    expect(sandbox).toHaveAttribute("data-content-id", "absent");
    expect(sandbox).toHaveAttribute("data-data-access", "absent");
  });

  it("remounts the sandbox when the mode changes, so the loaded-mode pin cannot outlive it", async () => {
    const { rerender } = render(
      <ArtifactCanvas
        {...BASE}
        dataBridgeEnabled={true}
        contentId="obj-1"
        dataAccess="records"
      />
    );
    const first = await screen.findByTestId("sandbox");
    expect(first).toHaveAttribute("data-data-access", "records");

    // Flipping the mode in Content settings triggers router.refresh(), which
    // re-renders this canvas with a fresher mode. A remount (new DOM node) is
    // the "fresh load" #1712 requires: the old iframe is destroyed, so nothing
    // queried under the old mode survives into the new one.
    rerender(
      <ArtifactCanvas
        {...BASE}
        dataBridgeEnabled={true}
        contentId="obj-1"
        dataAccess="query"
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("sandbox")).toHaveAttribute(
        "data-data-access",
        "query"
      )
    );
    expect(screen.getByTestId("sandbox")).not.toBe(first);
  });

  it("remounts the sandbox when the artifact changes without a canvas remount", async () => {
    const { rerender } = render(
      <ArtifactCanvas
        {...BASE}
        dataBridgeEnabled={true}
        contentId="obj-1"
        dataAccess="query"
      />
    );
    const first = await screen.findByTestId("sandbox");

    getCodeMock.mockResolvedValue({
      isSuccess: true,
      data: {
        objectId: "obj-2",
        versionId: "ver-9",
        code: "<p>other</p>",
        bodyFormat: "html",
      },
    });
    // WorkspacePanel swaps artifacts by resetting its own state rather than
    // remounting this canvas, so a version-only key could leave the previous
    // artifact's pin attached to a new content id.
    rerender(
      <ArtifactCanvas
        {...BASE}
        idOrSlug="obj-2"
        dataBridgeEnabled={true}
        contentId="obj-2"
        dataAccess="query"
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("sandbox")).toHaveAttribute(
        "data-content-id",
        "obj-2"
      )
    );
    expect(screen.getByTestId("sandbox")).not.toBe(first);
  });
});
