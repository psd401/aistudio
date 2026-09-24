import { act, render, screen } from "@testing-library/react";

/**
 * #1788 — what happens when the record op's Server Action CHUNK fails to load.
 *
 * `ArtifactSandbox` reaches `submitArtifactRecord` / `listArtifactRecords`
 * through a lazy `import()`, which keeps the server-only action graph out of
 * fail-closed and preview-only clients. That import is the first thing that can
 * fail, and it fails in a way the rest of the bridge never sees.
 *
 * The rule this file pins: a failed transport load is answered, never
 * ACKNOWLEDGED. The dispatch ack restarts the frame's 10s post-dispatch clock,
 * and the module loader deliberately forgets a rejected import so a later
 * request can retry it — so acking on failure would start that clock and then
 * kick off a SECOND import behind it. A slow retry would let the frame reject
 * the artifact's promise before the write ran, the write would land anyway, and
 * the author's retry would create a DUPLICATE record.
 *
 * This lives in its own file because making the import genuinely reject means
 * the module factory has to throw, which cannot be toggled per-test once Jest
 * has cached the module for a file.
 */
jest.mock("@/actions/db/atrium/artifact-data", () => {
  throw new Error("chunk load failed");
});

import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";

const SANDBOX_SRC = "https://sandbox.example.test/render";
const TRUSTED_CONTENT_ID = "trusted-content-id";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000f1";

/**
 * The same answer a THROWN transport already produced (see the catch in
 * `runBridgeRequest`): a chunk that never loaded and a request that blew up
 * mid-flight are the same thing to the artifact — the service is not there.
 */
const UNAVAILABLE_FAILURE = {
  code: "unavailable",
  error: "The data service is unavailable.",
} as const;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function mountRecordsSandbox(): {
  frameWindow: Window;
  postMessage: jest.Mock;
} {
  render(
    <ArtifactSandbox
      code="<p>artifact</p>"
      src={SANDBOX_SRC}
      dataBridgeEnabled={true}
      contentId={TRUSTED_CONTENT_ID}
      dataAccess="records"
    />
  );
  const frame = screen.getByTestId(
    "artifact-sandbox-frame"
  ) as HTMLIFrameElement;
  const frameWindow = frame.contentWindow;
  if (!frameWindow) throw new Error("test iframe has no contentWindow");
  const postMessage = jest.fn();
  Object.defineProperty(frameWindow, "postMessage", {
    configurable: true,
    value: postMessage,
  });
  return { frameWindow, postMessage };
}

function postedOfType(postMessage: jest.Mock, type: string): unknown[] {
  const calls = postMessage.mock.calls as Array<[message: unknown, to: unknown]>;
  return calls
    .map(([message]) => message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === type
    );
}

describe("ArtifactSandbox record transport failure (#1788)", () => {
  it("answers `unavailable` and NEVER acks when the action chunk fails to load", async () => {
    const { frameWindow, postMessage } = mountRecordsSandbox();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "atrium-artifact-data-request",
            requestId: REQUEST_ID,
            op: "submit",
            namespace: "signups",
            payload: { name: "a" },
          },
          origin: "null",
          source: frameWindow,
        })
      );
      await flushMicrotasks();
    });

    // No ack: the frame stays on its queue-tolerant pre-ack budget rather than
    // being told a request had started that had not.
    expect(postedOfType(postMessage, "atrium-artifact-data-ack")).toEqual([]);

    // And the artifact is told, rather than left to time out.
    const responses = postedOfType(
      postMessage,
      "atrium-artifact-data-response"
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: REQUEST_ID,
      ok: false,
      ...UNAVAILABLE_FAILURE,
    });
  });
});
