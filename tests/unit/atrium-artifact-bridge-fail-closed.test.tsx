/**
 * The surfaces that must STAY fail-closed after #1725.
 *
 * #1725 turned the data bridge on for the two authoring surfaces (the
 * full-screen viewer and the editor preview). The argument for that rests on
 * those surfaces having already run the same 404-masking `canView` the bridge's
 * server actions repeat. Embeds and library thumbnails have not: an embed
 * renders inside somebody else's document (including the anonymous `/p/<slug>`
 * reader) and a thumbnail is a decorative grid tile. Neither may ever acquire a
 * content id.
 *
 * This test pins the omission itself, because the omission is the control — a
 * future "just thread the props through everywhere" refactor would otherwise
 * silently hand the bridge to a public reader.
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

describe("surfaces that stay fail-closed after #1725", () => {
  it("ArtifactEmbedBlock mounts the sandbox without any bridge prop", async () => {
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
});
