/**
 * The surfaces that must STAY fail-closed after #1725 and #1790.
 *
 * #1725 turned the data bridge on for the two authoring surfaces (the
 * full-screen viewer and the editor preview), on the argument that they had
 * already run the same 404-masking `canView` the bridge's server actions repeat.
 *
 * #1790 extended that to AUTHENTICATED embeds — `resolveEmbedForReader` runs the
 * same gate for its `internal` audience, and without the bridge every embedded
 * live-data dashboard showed a "no access" tile to every reader of the document.
 * The line moved, so this file pins where it moved TO:
 *
 *  - an `ArtifactEmbedBlock` given no `dataBridge` (the default, and what the
 *    public `/p/<slug>` reader always resolves) mounts the sandbox with NONE of
 *    the enabling props — omission stays the fail-closed default, so a caller
 *    that forgets to thread it degrades to broken, never to open;
 *  - a library thumbnail never acquires a content id at all: it is a decorative
 *    grid tile with no `canView` of its own;
 *  - and a `query`-mode thumbnail does not even fetch the code (#1790 fix 4).
 *
 * The audience half of the contract — that `/p/` resolves `dataBridge: null`
 * while `/c/` does not — is pinned in `atrium-embed-resolver.test.ts`, because
 * that is where the decision is made.
 */

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const getCodeMock = jest.fn();
jest.mock("@/actions/db/atrium/get-artifact-code", () => ({
  getArtifactCodeAction: (...a: unknown[]) => getCodeMock(...a),
}));

/** Records every props object the sandbox was constructed with. */
const sandboxProps: Array<Record<string, unknown>> = [];
jest.mock("@/components/atrium/ArtifactSandbox", () => ({
  ArtifactSandbox: (props: Record<string, unknown>) => {
    sandboxProps.push(props);
    return <div data-testid="sandbox" />;
  },
}));

import { render, screen, waitFor } from "@testing-library/react";
import { ArtifactEmbedBlock } from "@/components/atrium/ArtifactEmbedBlock";
import { ArtifactThumbnail } from "@/components/atrium/ArtifactThumbnail";

/** Assert a mounted sandbox carries none of the three enabling props. */
function expectNoBridge(props: Record<string, unknown>): void {
  expect(props).not.toHaveProperty("dataBridgeEnabled");
  expect(props).not.toHaveProperty("contentId");
  expect(props).not.toHaveProperty("dataAccess");
}

beforeEach(() => {
  sandboxProps.length = 0;
  getCodeMock.mockReset();
});

describe("surfaces that stay fail-closed after #1725 and #1790", () => {
  it("ArtifactEmbedBlock mounts the sandbox without any bridge prop when none is resolved", async () => {
    render(
      <ArtifactEmbedBlock
        available
        title="Device repair dashboard"
        code="<p>artifact</p>"
        sandboxSrc="https://sandbox.example.test/render"
        href="/c/device-repair-dashboard"
      />
    );

    expect(screen.getByTestId("sandbox")).toBeInTheDocument();
    expect(sandboxProps).toHaveLength(1);
    expectNoBridge(sandboxProps[0]!);
  });

  it("ArtifactEmbedBlock treats an explicit null dataBridge (the /p/ resolve) as no bridge", async () => {
    render(
      <ArtifactEmbedBlock
        available
        title="Device repair dashboard"
        code="<p>artifact</p>"
        sandboxSrc="https://sandbox.example.test/render"
        href="/p/device-repair-dashboard"
        dataBridge={null}
      />
    );

    expect(sandboxProps).toHaveLength(1);
    expectNoBridge(sandboxProps[0]!);
  });

  it("ArtifactEmbedBlock enables the bridge ONLY from a resolved dataBridge (#1790)", async () => {
    render(
      <ArtifactEmbedBlock
        available
        title="Device repair dashboard"
        code="<p>artifact</p>"
        sandboxSrc="https://sandbox.example.test/render"
        href="/c/device-repair-dashboard"
        dataBridge={{ contentId: "obj-1", dataAccess: "query", versionId: "v9" }}
      />
    );

    expect(sandboxProps).toHaveLength(1);
    expect(sandboxProps[0]).toMatchObject({
      dataBridgeEnabled: true,
      contentId: "obj-1",
      dataAccess: "query",
      versionId: "v9",
    });
  });

  it("ArtifactThumbnail mounts the sandbox without any bridge prop", async () => {
    // The thumbnail only fetches code once its card intersects the viewport;
    // jsdom has no IntersectionObserver, so drive the callback immediately.
    class ImmediateIntersectionObserver {
      constructor(private readonly cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
      observe(): void {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    (
      globalThis as unknown as { IntersectionObserver: unknown }
    ).IntersectionObserver = ImmediateIntersectionObserver;

    getCodeMock.mockResolvedValue({
      isSuccess: true,
      data: { objectId: "obj-1", versionId: "ver-1", code: "<p>a</p>", bodyFormat: "html" },
    });

    render(
      <ArtifactThumbnail
        artifactId="obj-1"
        sandboxSrc="https://sandbox.example.test/render"
      />
    );

    await waitFor(() => expect(sandboxProps).toHaveLength(1));
    expectNoBridge(sandboxProps[0]!);
  });

  it("ArtifactThumbnail never runs a query-mode artifact (#1790)", async () => {
    // Without the bridge a query-mode artifact can only render its own
    // no-access state, so the grid advertised every live dashboard as broken.
    class ImmediateIntersectionObserver {
      constructor(private readonly cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
      observe(): void {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    (
      globalThis as unknown as { IntersectionObserver: unknown }
    ).IntersectionObserver = ImmediateIntersectionObserver;

    render(
      <ArtifactThumbnail
        artifactId="obj-2"
        sandboxSrc="https://sandbox.example.test/render"
        dataAccess="query"
      />
    );

    // No frame, and the code is not even fetched.
    expect(sandboxProps).toHaveLength(0);
    expect(getCodeMock).not.toHaveBeenCalled();
    expect(screen.getByText("● Live data dashboard")).toBeInTheDocument();
  });
});
