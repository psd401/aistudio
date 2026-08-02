import { act, render, screen, waitFor } from "@testing-library/react";

const submitArtifactRecordMock = jest.fn();
const listArtifactRecordsMock = jest.fn();

jest.mock("@/actions/db/atrium/artifact-data", () => ({
  submitArtifactRecord: (...args: unknown[]) =>
    submitArtifactRecordMock(...args),
  listArtifactRecords: (...args: unknown[]) => listArtifactRecordsMock(...args),
}));

import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";

const SANDBOX_SRC = "https://sandbox.example.test/render";
const TRUSTED_CONTENT_ID = "trusted-content-id";
const REQUEST_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
] as const;

interface PostedDataResponse {
  message: Record<string, unknown>;
  targetOrigin: unknown;
}

function isDataResponse(message: unknown): message is Record<string, unknown> {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type ===
      "atrium-artifact-data-response"
  );
}

function dataResponses(postMessage: jest.Mock): PostedDataResponse[] {
  const calls = postMessage.mock.calls as Array<
    [message: unknown, targetOrigin: unknown]
  >;
  return calls.flatMap(([message, targetOrigin]) =>
    isDataResponse(message) ? [{ message, targetOrigin }] : []
  );
}

function mountSandbox(enabled: boolean): {
  frameWindow: Window;
  postMessage: jest.Mock;
} {
  if (enabled) {
    render(
      <ArtifactSandbox
        code="<p>artifact</p>"
        src={SANDBOX_SRC}
        dataBridgeEnabled={true}
        contentId={TRUSTED_CONTENT_ID}
      />
    );
  } else {
    // This is the public-reader shape: the enabling prop and contentId are both
    // structurally absent.
    render(<ArtifactSandbox code="<p>artifact</p>" src={SANDBOX_SRC} />);
  }

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

async function sendMessage(
  data: unknown,
  source: MessageEventSource | null,
  origin = "null"
): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin,
        source,
      })
    );
    await Promise.resolve();
  });
}

function submitRequest(requestId: string): Record<string, unknown> {
  return {
    type: "atrium-artifact-data-request",
    requestId,
    op: "submit",
    namespace: "leaderboard",
    payload: { score: 42 },
  };
}

beforeEach(() => {
  submitArtifactRecordMock.mockReset().mockResolvedValue({
    isSuccess: true,
    message: "Artifact record submitted",
    data: { id: "record-1", createdAt: "2026-08-02T00:00:00.000Z" },
  });
  listArtifactRecordsMock.mockReset().mockResolvedValue({
    isSuccess: true,
    message: "Artifact records listed",
    data: { records: [] },
  });
});

describe("ArtifactSandbox artifact data bridge", () => {
  it("ignores a data request whose event.source is not this frame", async () => {
    const { postMessage } = mountSandbox(true);

    await sendMessage(submitRequest(REQUEST_IDS[0]), window);

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)).toEqual([]);
  });

  it("uses the trusted prop contentId, correlates requestId, and responds to the opaque frame with '*'", async () => {
    const { frameWindow, postMessage } = mountSandbox(true);
    const request = {
      ...submitRequest(REQUEST_IDS[0]),
      contentId: "attacker-controlled-content-id",
    };

    await sendMessage(request, frameWindow);

    expect(submitArtifactRecordMock).toHaveBeenCalledWith({
      contentId: TRUSTED_CONTENT_ID,
      namespace: "leaderboard",
      payload: { score: 42 },
    });
    expect(dataResponses(postMessage)).toEqual([
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: REQUEST_IDS[0],
          ok: true,
          data: {
            id: "record-1",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        },
        targetOrigin: "*",
      },
    ]);
  });

  it("drops a request with no requestId without invoking an action or responding", async () => {
    const { frameWindow, postMessage } = mountSandbox(true);
    const request = submitRequest(REQUEST_IDS[0]);
    delete request.requestId;

    await sendMessage(request, frameWindow);

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)).toEqual([]);
  });

  it("maps list requests and does not use event.origin as sender authentication", async () => {
    const { frameWindow, postMessage } = mountSandbox(true);

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[1],
        op: "list",
        namespace: "leaderboard",
        limit: 25,
        scope: "mine",
      },
      frameWindow,
      "https://origin-is-not-the-authenticator.example"
    );

    expect(listArtifactRecordsMock).toHaveBeenCalledWith({
      contentId: TRUSTED_CONTENT_ID,
      namespace: "leaderboard",
      limit: 25,
      scope: "mine",
    });
    expect(dataResponses(postMessage)[0]).toEqual({
      message: {
        type: "atrium-artifact-data-response",
        requestId: REQUEST_IDS[1],
        ok: true,
        data: { records: [] },
      },
      targetOrigin: "*",
    });
  });
});

describe("ArtifactSandbox artifact data bridge failure controls", () => {
  it("rejects an oversized payload before invoking or serializing a Server Action", async () => {
    const { frameWindow, postMessage } = mountSandbox(true);
    const request = {
      ...submitRequest(REQUEST_IDS[0]),
      payload: { value: "x".repeat(8 * 1024 + 1) },
    };

    await sendMessage(request, frameWindow);

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)).toEqual([
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: REQUEST_IDS[0],
          ok: false,
          error: "Artifact data request failed",
        },
        targetOrigin: "*",
      },
    ]);
  });

  it("refuses every request when disabled and never invokes either action", async () => {
    const { frameWindow, postMessage } = mountSandbox(false);

    await sendMessage(submitRequest(REQUEST_IDS[0]), frameWindow);
    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[1],
        op: "list",
        namespace: "leaderboard",
      },
      frameWindow
    );

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(listArtifactRecordsMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)).toEqual([
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: REQUEST_IDS[0],
          ok: false,
          error: "Artifact data request failed",
        },
        targetOrigin: "*",
      },
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: REQUEST_IDS[1],
          ok: false,
          error: "Artifact data request failed",
        },
        targetOrigin: "*",
      },
    ]);
  });

  it("returns a generic failure without leaking the underlying action message", async () => {
    const { frameWindow, postMessage } = mountSandbox(true);
    submitArtifactRecordMock.mockResolvedValueOnce({
      isSuccess: false,
      message: "relation content_data_records missing for private-content-id",
      error: new Error("database host db.internal.example refused connection"),
    });

    await sendMessage(submitRequest(REQUEST_IDS[0]), frameWindow);

    const [response] = dataResponses(postMessage);
    expect(response).toEqual({
      message: {
        type: "atrium-artifact-data-response",
        requestId: REQUEST_IDS[0],
        ok: false,
        error: "Artifact data request failed",
      },
      targetOrigin: "*",
    });
    expect(JSON.stringify(response)).not.toMatch(
      /content_data_records|private-content-id|db\.internal/i
    );
  });

  it("bounds in-flight action work per frame", async () => {
    const { frameWindow, postMessage } = mountSandbox(true);
    type SubmitSuccess = {
      isSuccess: true;
      message: string;
      data: { id: string; createdAt: string };
    };
    const resolvers: Array<(result: SubmitSuccess) => void> = [];
    submitArtifactRecordMock.mockImplementation(
      () =>
        new Promise<SubmitSuccess>((resolve) => {
          resolvers.push(resolve);
        })
    );

    await act(async () => {
      for (const requestId of REQUEST_IDS) {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: submitRequest(requestId),
            origin: "null",
            source: frameWindow,
          })
        );
      }
    });

    expect(submitArtifactRecordMock).toHaveBeenCalledTimes(8);
    expect(dataResponses(postMessage)).toContainEqual({
      message: {
        type: "atrium-artifact-data-response",
        requestId: REQUEST_IDS[8],
        ok: false,
        error: "Artifact data request failed",
      },
      targetOrigin: "*",
    });

    await act(async () => {
      let index = 0;
      for (const resolve of resolvers) {
        resolve({
          isSuccess: true,
          message: "ok",
          data: {
            id: `record-${index}`,
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        });
        index += 1;
      }
      await Promise.resolve();
    });
    await waitFor(() => expect(dataResponses(postMessage)).toHaveLength(9));
  });
});
