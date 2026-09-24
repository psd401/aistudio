import { act, render, screen, waitFor } from "@testing-library/react";

const submitArtifactRecordMock = jest.fn();
const listArtifactRecordsMock = jest.fn();
const queryArtifactDataMock = jest.fn();

jest.mock("@/actions/db/atrium/artifact-data", () => ({
  submitArtifactRecord: (...args: unknown[]) =>
    submitArtifactRecordMock(...args),
  listArtifactRecords: (...args: unknown[]) => listArtifactRecordsMock(...args),
}));

import {
  ArtifactSandbox,
  type ArtifactSandboxDiagnostic,
} from "@/components/atrium/ArtifactSandbox";
import {
  ARTIFACT_QUERY_STATUS_BY_CODE,
  artifactQueryRoutePath,
} from "@/lib/content/artifact-query-transport";
import type { ContentDataAccess } from "@/lib/content/types";

/**
 * #1788: `query` no longer goes through a Server Action — it POSTs to
 * `/api/atrium/artifacts/{id}/query`, because the App Router dispatches Server
 * Actions ONE AT A TIME and that serialized every dashboard's queries.
 *
 * The suites below still express their expectations in terms of
 * `queryArtifactDataMock`, because the route's whole job is to call that action
 * with exactly those arguments. This stub is the route: it decodes the request
 * the bridge actually built (including the base64 SQL that gets it past the edge
 * WAF's `SQLi_BODY` rule), hands it to the mock, and answers with the status the
 * route would answer with. What the bridge sends on the wire is asserted
 * directly in the transport suite.
 */
interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const fetchMock = jest.fn<Promise<StubResponse>, [string, RequestInit]>();

function decodeQueryBody(init: RequestInit): Record<string, unknown> {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  const sqlBase64 = String(body.sqlBase64 ?? "");
  return {
    sql: Buffer.from(sqlBase64, "base64").toString("utf8"),
    limit: body.limit,
    offset: body.offset,
    versionId: body.versionId,
  };
}

/** The default stub: run the mock action and map its outcome to a response. */
async function routeStub(url: string, init: RequestInit): Promise<StubResponse> {
  const contentId = decodeURIComponent(
    url.replace(/^\/api\/atrium\/artifacts\//, "").replace(/\/query$/, "")
  );
  const { sql, limit, offset, versionId } = decodeQueryBody(init);
  const outcome = (await queryArtifactDataMock({
    contentId,
    sql,
    limit,
    offset,
    versionId,
  })) as { isSuccess: boolean; code?: string };
  const status = outcome.isSuccess
    ? 200
    : ARTIFACT_QUERY_STATUS_BY_CODE[
        outcome.code as keyof typeof ARTIFACT_QUERY_STATUS_BY_CODE
      ] ?? 503;
  return { ok: outcome.isSuccess, status, json: async () => outcome };
}

/** A response with no usable typed body — a WAF block, an ALB 502, a bare 401. */
function bodylessResponse(status: number): StubResponse {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  };
}

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

/**
 * Ids for the parent-side narrowing tests below. Deliberately NOT part of
 * `REQUEST_IDS`: the in-flight-cap test dispatches one request per entry of
 * that array and asserts an exact response count, so appending to it silently
 * changes what that test exercises.
 */
const NARROWING_REQUEST_IDS = [
  "00000000-0000-4000-8000-000000000010",
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
] as const;

/**
 * Ids for the #1712 loaded-mode pin tests. Separate from both arrays above for
 * the same reason: the in-flight-cap test counts responses exactly.
 */
const MODE_PIN_REQUEST_IDS = [
  "00000000-0000-4000-8000-000000000020",
  "00000000-0000-4000-8000-000000000021",
  "00000000-0000-4000-8000-000000000022",
  "00000000-0000-4000-8000-000000000023",
  "00000000-0000-4000-8000-000000000024",
  "00000000-0000-4000-8000-000000000025",
  "00000000-0000-4000-8000-000000000026",
  "00000000-0000-4000-8000-000000000027",
] as const;

/**
 * Ids for the #1787 typed-failure / diagnostics suite. Nine of them, so the
 * in-flight-cap case can overrun the cap of eight. Separate from every array
 * above for the reason the others are.
 */
const DIAGNOSTIC_REQUEST_IDS = [
  "00000000-0000-4000-8000-000000000030",
  "00000000-0000-4000-8000-000000000031",
  "00000000-0000-4000-8000-000000000032",
  "00000000-0000-4000-8000-000000000033",
  "00000000-0000-4000-8000-000000000034",
  "00000000-0000-4000-8000-000000000035",
  "00000000-0000-4000-8000-000000000036",
  "00000000-0000-4000-8000-000000000037",
  "00000000-0000-4000-8000-000000000038",
] as const;

/**
 * #1787 expectation helpers. Every bridge failure now carries a typed `code`
 * alongside the message, so these name the answers the parent-side gates
 * produce rather than repeating literals at a dozen call sites.
 */
/** The pre-#1787 generic answer, kept verbatim for the record ops. */
const GENERIC_FAILURE = {
  code: "unavailable",
  error: "Artifact data request failed",
} as const;
/** A record op refused by the page's loaded mode (#1712). */
const MODE_PIN_RECORD_FAILURE = {
  code: "not_query_mode",
  error: "This artifact's data mode does not allow record operations.",
} as const;
/** A query refused by the page's loaded mode (#1712). */
const MODE_PIN_QUERY_FAILURE = {
  code: "not_query_mode",
  error: "This artifact is not configured for live data queries.",
} as const;
/** The per-frame in-flight cap. */
const TOO_MANY_REQUESTS_FAILURE = {
  code: "too_many_requests",
  error: "Too many data requests are already running on this page.",
} as const;

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

/**
 * Mount the sandbox with the bridge enabled (pinned to `dataAccess`, #1712) or
 * structurally disabled. `records` is the default because it is the column
 * default and the mode the submit/list suites exercise.
 */
function mountSandbox(
  enabled: boolean,
  dataAccess: ContentDataAccess = "records"
): {
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
        dataAccess={dataAccess}
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

/**
 * Let every queued microtask run. A `query` now crosses `fetch` → `.json()` →
 * the response post, so a single `await Promise.resolve()` no longer reaches the
 * end of one request (#1788).
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
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
    await flushMicrotasks();
  });
}

/** Every dispatch ack the parent posted, in order (#1788). */
function dispatchAcks(postMessage: jest.Mock): string[] {
  const calls = postMessage.mock.calls as Array<[message: unknown, origin: unknown]>;
  return calls.flatMap(([message]) =>
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "atrium-artifact-data-ack"
      ? [String((message as { requestId?: unknown }).requestId)]
      : []
  );
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
  fetchMock.mockReset().mockImplementation(routeStub);
  (globalThis as { fetch: unknown }).fetch = fetchMock;
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
  queryArtifactDataMock.mockReset().mockResolvedValue({
    isSuccess: true,
    message: "Artifact data query completed",
    data: {
      columns: ["school"],
      rows: [["Peninsula HS"]],
      totalCount: 1,
      returnedCount: 1,
      limit: 200,
      offset: 0,
      truncated: false,
    },
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

/**
 * #1705 — the query op. The bridge must copy ONLY sql/limit/offset out of the
 * frame's message; every other field (contentId, tool name, export, format,
 * reason) is either taken from trusted props or forced by the Server Action.
 */
/**
 * #1787: a query the narrowing predicate rejects is ANSWERED at once with
 * `query_error` — not dropped, which left the artifact waiting out the host's
 * 45s timeout and reporting `timeout` for a bad argument.
 */
function expectMalformedQueryAnswer(postMessage: jest.Mock): void {
  expect(dataResponses(postMessage)).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({ ok: false, code: "query_error" }),
    }),
  ]);
}

describe("ArtifactSandbox viewer-scoped query bridge", () => {
  it("copies only sql/limit/offset and uses the trusted prop contentId", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[2],
        op: "query",
        sql: "SELECT 1",
        limit: 10,
        offset: 5,
        // Fields a hostile page might attach — none may reach the action.
        contentId: "attacker-chosen-content",
        namespace: "leaderboard",
        export: true,
        format: "csv",
        reason: "totally legitimate",
      },
      frameWindow,
      "https://origin-is-not-the-authenticator.example"
    );

    expect(queryArtifactDataMock).toHaveBeenCalledWith({
      contentId: TRUSTED_CONTENT_ID,
      sql: "SELECT 1",
      limit: 10,
      offset: 5,
    });
    expect(dataResponses(postMessage)[0]?.targetOrigin).toBe("*");
    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(listArtifactRecordsMock).not.toHaveBeenCalled();
  });

  it("answers a query request with no sql as query_error without invoking the action", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[3],
        op: "query",
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expectMalformedQueryAnswer(postMessage);
  });

  it("refuses oversized SQL before serializing a Server Action payload", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[4],
        op: "query",
        sql: "a".repeat(8_001),
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expectMalformedQueryAnswer(postMessage);
  });

  it("answers whitespace-only SQL as query_error without invoking the action", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: NARROWING_REQUEST_IDS[0],
        op: "query",
        sql: "   \n\t ",
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expectMalformedQueryAnswer(postMessage);
  });

  it("answers a negative limit as query_error without invoking the action", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: NARROWING_REQUEST_IDS[1],
        op: "query",
        sql: "SELECT 1",
        limit: -1,
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expectMalformedQueryAnswer(postMessage);
  });

  it("answers a negative offset as query_error without invoking the action", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: NARROWING_REQUEST_IDS[2],
        op: "query",
        sql: "SELECT 1",
        offset: -5,
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expectMalformedQueryAnswer(postMessage);
  });

  it("refuses every query when the bridge is disabled", async () => {
    const { frameWindow, postMessage } = mountSandbox(false);

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[5],
        op: "query",
        sql: "SELECT 1",
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: REQUEST_IDS[5],
      ok: false,
      ...GENERIC_FAILURE,
    });
  });

  it("returns the generic failure when the action refuses", async () => {
    queryArtifactDataMock.mockResolvedValueOnce({
      isSuccess: false,
      message: "Artifact is not configured for data queries",
    });
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: REQUEST_IDS[6],
        op: "query",
        sql: "SELECT 1",
      },
      frameWindow
    );

    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: REQUEST_IDS[6],
      ok: false,
      ...GENERIC_FAILURE,
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
          ...GENERIC_FAILURE,
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
          ...GENERIC_FAILURE,
        },
        targetOrigin: "*",
      },
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: REQUEST_IDS[1],
          ok: false,
          ...GENERIC_FAILURE,
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
        ...GENERIC_FAILURE,
      },
      targetOrigin: "*",
    });
    expect(JSON.stringify(response)).not.toMatch(
      /content_data_records|private-content-id|db\.internal/i
    );
  });

  /**
   * #1788: the old hard cap of 8 REJECTED the 9th concurrent call. Excess work
   * now queues behind a concurrency limit of 6 and every request is answered —
   * a dashboard with more panels than the limit is not a failure case.
   */
  it("queues past the concurrency limit instead of rejecting, and answers all", async () => {
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
      await flushMicrotasks();
    });

    // Six dispatched, three waiting — and NOTHING refused.
    expect(submitArtifactRecordMock).toHaveBeenCalledTimes(6);
    expect(dispatchAcks(postMessage)).toEqual(REQUEST_IDS.slice(0, 6));
    expect(dataResponses(postMessage)).toEqual([]);

    const drain = async (): Promise<void> => {
      await act(async () => {
        const batch = resolvers.splice(0, resolvers.length);
        for (const [index, resolve] of batch.entries()) {
          resolve({
            isSuccess: true,
            message: "ok",
            data: {
              id: `record-${index}`,
              createdAt: "2026-08-02T00:00:00.000Z",
            },
          });
        }
        await flushMicrotasks();
      });
    };
    await drain();
    // Completing the first six pulls the queued three through.
    expect(submitArtifactRecordMock).toHaveBeenCalledTimes(9);
    await drain();
    await waitFor(() => expect(dataResponses(postMessage)).toHaveLength(9));
    expect(
      dataResponses(postMessage).every(({ message }) => message.ok === true)
    ).toBe(true);
    expect(dispatchAcks(postMessage)).toEqual([...REQUEST_IDS]);
  });

});

/** The one case that IS still refused: a full queue (#1788). */
describe("ArtifactSandbox bounded request queue (#1788)", () => {
  it("refuses only once the bounded queue is FULL", async () => {
    // 32 queued + 6 in flight is the whole budget; the 39th is refused.
    const ids = Array.from({ length: 39 }, (_, index) =>
      `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`
    );
    const { frameWindow, postMessage } = mountSandbox(true);
    submitArtifactRecordMock.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      for (const requestId of ids) {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: submitRequest(requestId),
            origin: "null",
            source: frameWindow,
          })
        );
      }
      await flushMicrotasks();
    });

    expect(dataResponses(postMessage)).toEqual([
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: ids[38],
          ok: false,
          ...TOO_MANY_REQUESTS_FAILURE,
        },
        targetOrigin: "*",
      },
    ]);
  });
});

/**
 * Mount with one mode, then re-render the SAME mount with another. Models an
 * RSC re-render of the reader handing the component a fresher prop; the pin
 * must stay at the mode the mount started with (#1712).
 */
function mountThenRerenderSandbox(
  initial: ContentDataAccess,
  later: ContentDataAccess
): { frameWindow: Window; postMessage: jest.Mock } {
  const sandbox = (dataAccess: ContentDataAccess) => (
    <ArtifactSandbox
      code="<p>artifact</p>"
      src={SANDBOX_SRC}
      dataBridgeEnabled={true}
      contentId={TRUSTED_CONTENT_ID}
      dataAccess={dataAccess}
    />
  );
  const view = render(sandbox(initial));
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
  view.rerender(sandbox(later));
  return { frameWindow, postMessage };
}

/**
 * #1712 — the loaded-mode pin. The owner can change `content_objects.data_access`
 * at any time (settings, REST PATCH, MCP) while a viewer's tab stays open. The
 * server check runs against the CURRENT value, so on its own it would let a page
 * loaded in `query` mode (holding queried rows in memory) submit them once the
 * owner flipped to `records`. The parent therefore refuses any op that does not
 * match the mode the page was LOADED with, before the action is ever called.
 */
describe("ArtifactSandbox loaded-mode pin", () => {
  it("refuses submit on a page loaded in query mode (the exfiltration loop)", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(submitRequest(MODE_PIN_REQUEST_IDS[0]), frameWindow);

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)).toEqual([
      {
        message: {
          type: "atrium-artifact-data-response",
          requestId: MODE_PIN_REQUEST_IDS[0],
          ok: false,
          ...MODE_PIN_RECORD_FAILURE,
        },
        targetOrigin: "*",
      },
    ]);
  });

  it("refuses list on a page loaded in query mode", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "query");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: MODE_PIN_REQUEST_IDS[1],
        op: "list",
        namespace: "leaderboard",
      },
      frameWindow
    );

    expect(listArtifactRecordsMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: MODE_PIN_REQUEST_IDS[1],
      ok: false,
      ...MODE_PIN_RECORD_FAILURE,
    });
  });

  it("refuses query on a page loaded in records mode", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "records");

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: MODE_PIN_REQUEST_IDS[2],
        op: "query",
        sql: "SELECT 1",
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: MODE_PIN_REQUEST_IDS[2],
      ok: false,
      ...MODE_PIN_QUERY_FAILURE,
    });
  });

  it("keeps the mount's mode when a re-render supplies a wider one", async () => {
    // An RSC re-render of the reader after the owner flipped `data_access`
    // would hand this component a fresher prop. The already-running artifact
    // still holds whatever it queried under the OLD mode, so the pin must be
    // the mode at mount — only a fresh mount may widen.
    const { frameWindow, postMessage } = mountThenRerenderSandbox(
      "query",
      "records"
    );

    await sendMessage(submitRequest(MODE_PIN_REQUEST_IDS[6]), frameWindow);

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: MODE_PIN_REQUEST_IDS[6],
      ok: false,
      ...MODE_PIN_RECORD_FAILURE,
    });
  });

  it("keeps a records-mode pin when a re-render supplies query mode", async () => {
    // The symmetric direction: a page that loaded with the record store must
    // not gain live queries from a later, wider prop either.
    const { frameWindow, postMessage } = mountThenRerenderSandbox(
      "records",
      "query"
    );

    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: MODE_PIN_REQUEST_IDS[7],
        op: "query",
        sql: "SELECT 1",
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: MODE_PIN_REQUEST_IDS[7],
      ok: false,
      ...MODE_PIN_QUERY_FAILURE,
    });
  });

  it("refuses all three ops on a page loaded in none mode", async () => {
    const { frameWindow, postMessage } = mountSandbox(true, "none");

    await sendMessage(submitRequest(MODE_PIN_REQUEST_IDS[3]), frameWindow);
    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: MODE_PIN_REQUEST_IDS[4],
        op: "list",
        namespace: "leaderboard",
      },
      frameWindow
    );
    await sendMessage(
      {
        type: "atrium-artifact-data-request",
        requestId: MODE_PIN_REQUEST_IDS[5],
        op: "query",
        sql: "SELECT 1",
      },
      frameWindow
    );

    expect(submitArtifactRecordMock).not.toHaveBeenCalled();
    expect(listArtifactRecordsMock).not.toHaveBeenCalled();
    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(
      dataResponses(postMessage).map((response) => response.message)
    ).toEqual([
      {
        type: "atrium-artifact-data-response",
        requestId: MODE_PIN_REQUEST_IDS[3],
        ok: false,
        ...MODE_PIN_RECORD_FAILURE,
      },
      {
        type: "atrium-artifact-data-response",
        requestId: MODE_PIN_REQUEST_IDS[4],
        ok: false,
        ...MODE_PIN_RECORD_FAILURE,
      },
      {
        type: "atrium-artifact-data-response",
        requestId: MODE_PIN_REQUEST_IDS[5],
        ok: false,
        ...MODE_PIN_QUERY_FAILURE,
      },
    ]);
  });
});

/** #1787: mount in query mode with a diagnostic sink and a pinned version id. */
function mountQuerySandbox(versionId?: string): {
  frameWindow: Window;
  postMessage: jest.Mock;
  diagnostics: ArtifactSandboxDiagnostic[];
  unmount: () => void;
} {
  const diagnostics: ArtifactSandboxDiagnostic[] = [];
  const { unmount } = render(
    <ArtifactSandbox
      code="<p>artifact</p>"
      src={SANDBOX_SRC}
      dataBridgeEnabled={true}
      contentId={TRUSTED_CONTENT_ID}
      dataAccess="query"
      versionId={versionId}
      onDiagnostic={(diagnostic) => diagnostics.push(diagnostic)}
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
  return { frameWindow, postMessage, diagnostics, unmount };
}

function queryRequest(requestId: string, sql = "SELECT nope") {
  return {
    type: "atrium-artifact-data-request",
    requestId,
    op: "query" as const,
    sql,
  };
}

/**
 * #1788 — the query TRANSPORT. `AtriumData.query` used to reach a Server Action,
 * which the App Router dispatches one at a time; it now POSTs to a route handler
 * so a dashboard's queries actually overlap.
 */
describe("ArtifactSandbox query transport (#1788)", () => {
  it("POSTs to the artifact query route with the SQL base64-encoded", async () => {
    const { frameWindow } = mountQuerySandbox("version-9");

    await sendMessage(
      { ...queryRequest(REQUEST_IDS[0], "SELECT 1"), limit: 10, offset: 5 },
      frameWindow
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(artifactQueryRoutePath(TRUSTED_CONTENT_ID));
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Raw SQL in a request body is exactly what the edge WAF's SQLi_BODY rule
    // blocks — with a bare 403 the app never sees. It travels base64.
    expect(body.sqlBase64).toBe(Buffer.from("SELECT 1", "utf8").toString("base64"));
    expect(String(init.body)).not.toContain("SELECT 1");
    expect(body).toMatchObject({ limit: 10, offset: 5, versionId: "version-9" });
  });

  it("runs concurrent queries in parallel rather than back to back", async () => {
    let concurrent = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    fetchMock.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise<void>((resolve) => release.push(resolve));
      concurrent -= 1;
      return { ok: true, status: 200, json: async () => ({ isSuccess: true, data: {} }) };
    });
    const { frameWindow } = mountQuerySandbox();

    await act(async () => {
      for (const requestId of REQUEST_IDS.slice(0, 6)) {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: queryRequest(requestId, "SELECT 1"),
            origin: "null",
            source: frameWindow,
          })
        );
      }
      await flushMicrotasks();
    });

    // The whole point of the issue: six queries, six simultaneous requests.
    expect(peak).toBe(6);
    await act(async () => {
      for (const resolve of release) resolve();
      await flushMicrotasks();
    });
  });

  it("derives a typed code from the STATUS when the response carries no body", async () => {
    // middleware answers a signed-out /api/* request with a plain 401, and a
    // WAF block is an HTML 403 — neither carries the typed bridge body.
    fetchMock.mockResolvedValueOnce(bodylessResponse(401));
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(queryRequest(REQUEST_IDS[1], "SELECT 1"), frameWindow);

    expect(dataResponses(postMessage)[0]?.message).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });

  it("does not trust a 2xx whose body is not the success envelope", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ surprise: true }),
    });
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(queryRequest(REQUEST_IDS[2], "SELECT 1"), frameWindow);

    expect(dataResponses(postMessage)[0]?.message).toMatchObject({
      ok: false,
      ...GENERIC_FAILURE,
    });
  });

  it("acks each query at DISPATCH so the frame's clock excludes queue time", async () => {
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(queryRequest(REQUEST_IDS[3], "SELECT 1"), frameWindow);

    expect(dispatchAcks(postMessage)).toEqual([REQUEST_IDS[3]]);
  });
});

/**
 * #1787 — the typed failure contract: the frame must be able to tell a broken
 * query from a permissions problem, which one generic string never allowed.
 */
describe("ArtifactSandbox typed failures (#1787)", () => {
  it("round-trips the action's typed code and message to the frame", async () => {
    queryArtifactDataMock.mockResolvedValueOnce({
      isSuccess: false,
      code: "query_error",
      message: 'column "school_name" does not exist',
      detail: 'column "school_name" does not exist',
    });
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(queryRequest(DIAGNOSTIC_REQUEST_IDS[0]), frameWindow);

    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: DIAGNOSTIC_REQUEST_IDS[0],
      ok: false,
      code: "query_error",
      error: 'column "school_name" does not exist',
    });
  });

  it("carries retryAfterSeconds for rate_limited and nothing else", async () => {
    queryArtifactDataMock
      .mockResolvedValueOnce({
        isSuccess: false,
        code: "rate_limited",
        message: "Too many data requests. Try again in a moment.",
        retryAfterSeconds: 30,
      })
      .mockResolvedValueOnce({
        isSuccess: false,
        code: "forbidden",
        message: "You do not have access to this data.",
        // A stray retry hint on a non-rate-limit code must not be forwarded.
        retryAfterSeconds: 30,
      });
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(queryRequest(DIAGNOSTIC_REQUEST_IDS[0]), frameWindow);
    await sendMessage(queryRequest(DIAGNOSTIC_REQUEST_IDS[1]), frameWindow);

    const [limited, forbidden] = dataResponses(postMessage);
    expect(limited?.message).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(forbidden?.message).not.toHaveProperty("retryAfterSeconds");
  });

  it("drops an unrecognized code AND its unvetted message", async () => {
    // A payload from an older action (or a corrupted one) has not been through
    // the server's disclosure gate, so neither half of it may be forwarded.
    queryArtifactDataMock.mockResolvedValueOnce({
      isSuccess: false,
      code: "totally_new_code",
      message: "relation content_data_records missing for private-content-id",
    });
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(queryRequest(DIAGNOSTIC_REQUEST_IDS[0]), frameWindow);

    expect(dataResponses(postMessage)[0]?.message).toEqual({
      type: "atrium-artifact-data-response",
      requestId: DIAGNOSTIC_REQUEST_IDS[0],
      ok: false,
      ...GENERIC_FAILURE,
    });
  });

  it("passes the trusted versionId to the action, never a request field", async () => {
    const { frameWindow } = mountQuerySandbox("version-from-props");

    await sendMessage(
      {
        ...queryRequest(DIAGNOSTIC_REQUEST_IDS[0]),
        // A hostile page naming its own version must be ignored.
        versionId: "version-from-the-artifact",
      },
      frameWindow
    );

    expect(queryArtifactDataMock).toHaveBeenCalledWith({
      contentId: TRUSTED_CONTENT_ID,
      sql: "SELECT nope",
      limit: undefined,
      offset: undefined,
      versionId: "version-from-props",
    });
  });
});

/**
 * #1787 — the diagnostic channel: SOMETHING on the app side has to notice a
 * failure the artifact swallowed, or a chat can write a dead dashboard and
 * report success.
 */
describe("ArtifactSandbox preview diagnostics (#1787)", () => {
  it("reports a rejected query to onDiagnostic with its code and SQL", async () => {
    queryArtifactDataMock.mockResolvedValueOnce({
      isSuccess: false,
      code: "query_error",
      message: 'column "school_name" does not exist',
    });
    const { frameWindow, diagnostics } = mountQuerySandbox();

    await sendMessage(
      queryRequest(DIAGNOSTIC_REQUEST_IDS[0], "SELECT school_name FROM x"),
      frameWindow
    );

    expect(diagnostics).toEqual([
      {
        kind: "data",
        code: "query_error",
        message: 'column "school_name" does not exist',
        sql: "SELECT school_name FROM x",
      },
    ]);
  });

  it("ANSWERS a malformed query instead of letting it time out", async () => {
    // Oversized SQL fails the narrowing predicate. Before, it was dropped: the
    // artifact waited out its own timeout and reported `timeout` for what is
    // really a bad argument, and no diagnostic was recorded (Codex P2, #1808).
    const { frameWindow, postMessage, diagnostics } = mountQuerySandbox();

    await sendMessage(
      {
        ...queryRequest(DIAGNOSTIC_REQUEST_IDS[0]),
        sql: "a".repeat(8_001),
      },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "atrium-artifact-data-response",
        requestId: DIAGNOSTIC_REQUEST_IDS[0],
        ok: false,
        code: "query_error",
      }),
      "*"
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ kind: "data", code: "query_error" }),
    ]);
    // The recorded SQL is bounded to the bridge's own SQL cap.
    expect(diagnostics[0]?.sql).toHaveLength(8_000);
  });

  it("answers a negative limit as query_error", async () => {
    const { frameWindow, postMessage } = mountQuerySandbox();

    await sendMessage(
      { ...queryRequest(DIAGNOSTIC_REQUEST_IDS[0]), limit: -1 },
      frameWindow
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: "query_error" }),
      "*"
    );
  });

  it("still ignores a message that is not a data request at all", async () => {
    const { frameWindow, postMessage, diagnostics } = mountQuerySandbox();

    await sendMessage(
      { type: "atrium-artifact-data-request", requestId: "bad id!", op: "query" },
      frameWindow
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it("queues nine concurrent queries without reporting a single refusal", async () => {
    // #1788: nine queries used to overrun the cap of eight and one was refused
    // with a code the artifact could do nothing about. They now queue.
    queryArtifactDataMock.mockImplementation(() => new Promise(() => {}));
    const { frameWindow, diagnostics } = mountQuerySandbox();

    await act(async () => {
      for (const requestId of DIAGNOSTIC_REQUEST_IDS) {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: queryRequest(requestId),
            origin: "null",
            source: frameWindow,
          })
        );
      }
      await flushMicrotasks();
    });

    expect(diagnostics).toEqual([]);
  });

  it("drops a failure that resolves after the sandbox unmounted", async () => {
    // The canvas remounts the sandbox on every version switch, but that does not
    // cancel a server action already in flight: its late failure describes the
    // OLD version and must not land in the new version's buffer.
    let resolveQuery: (value: unknown) => void = () => undefined;
    queryArtifactDataMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveQuery = resolve))
    );
    const { frameWindow, diagnostics, unmount } = mountQuerySandbox();

    await sendMessage(queryRequest(DIAGNOSTIC_REQUEST_IDS[0]), frameWindow);
    unmount();
    await act(async () => {
      resolveQuery({ isSuccess: false, code: "query_error", message: "stale" });
      await Promise.resolve();
    });

    expect(queryArtifactDataMock).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
  });

});

/**
 * #1787 — what the FRAME itself reports: its uncaught errors, and bridge
 * failures it raised locally (its own timeout or pending cap). Its own suite so
 * the diagnostics suite stays inside the max-lines-per-function budget.
 */
describe("ArtifactSandbox forwarded frame errors (#1787)", () => {
  it("forwards the frame's uncaught errors as script diagnostics", async () => {
    const { frameWindow, diagnostics } = mountQuerySandbox();

    await sendMessage(
      { type: "atrium-artifact-error", message: "Chart is not defined" },
      frameWindow
    );

    expect(diagnostics).toEqual([
      { kind: "script", message: "Chart is not defined" },
    ]);
  });

  it("records a frame-side bridge failure as a DATA diagnostic with its code", async () => {
    const { frameWindow, diagnostics } = mountQuerySandbox();

    await sendMessage(
      {
        type: "atrium-artifact-error",
        kind: "data",
        code: "timeout",
        message: "Atrium data request timed out",
        sql: "select slow()",
      },
      frameWindow
    );

    expect(diagnostics).toEqual([
      {
        kind: "data",
        code: "timeout",
        message: "Atrium data request timed out",
        sql: "select slow()",
      },
    ]);
  });

  it("keeps a frame report with an unknown code as a plain script error", async () => {
    const { frameWindow, diagnostics } = mountQuerySandbox();

    await sendMessage(
      { type: "atrium-artifact-error", kind: "data", code: "made_up", message: "x" },
      frameWindow
    );

    expect(diagnostics).toEqual([{ kind: "script", message: "x" }]);
  });

  it("ignores a frame error from any window that is not this frame", async () => {
    const { diagnostics } = mountQuerySandbox();

    await sendMessage(
      { type: "atrium-artifact-error", message: "spoofed" },
      window
    );

    expect(diagnostics).toEqual([]);
  });
});
