/**
 * Security and contract coverage for `queryArtifactData` (#1705) — the
 * viewer-scoped PSD data read behind `AtriumData.query`.
 *
 * Session, requester, visibility, router config, connector, and rate-limit
 * collaborators are mocked so these tests exercise the action boundary: which
 * arguments are FORCED server-side, which gates must fire before a request can
 * reach the data MCP, and that no upstream error text escapes.
 */

import { NotFoundError } from "@/lib/content/errors";

const mockGetServerSession = jest.fn();
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => mockGetServerSession(),
}));

const mockGetUserRequester = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...args: unknown[]) => mockGetUserRequester(...args),
}));

const mockContentGet = jest.fn();
const mockVersionGetById = jest.fn();
jest.mock("@/lib/content", () => ({
  contentService: {
    get: (...args: unknown[]) => mockContentGet(...args),
  },
  versionService: {
    getById: (...args: unknown[]) => mockVersionGetById(...args),
  },
}));

const mockCanEdit = jest.fn();
jest.mock("@/lib/content/helpers", () => ({
  canEdit: (...args: unknown[]) => mockCanEdit(...args),
}));

const mockConsumeRateLimit = jest.fn();
jest.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: (...args: unknown[]) => mockConsumeRateLimit(...args),
}));

const mockGetConnectorTools = jest.fn();
jest.mock("@/lib/mcp/connector-service", () => ({
  getConnectorTools: (...args: unknown[]) => mockGetConnectorTools(...args),
}));

const mockGetNexusRouterConfig = jest.fn();
jest.mock("@/lib/nexus/model-router/config", () => ({
  getNexusRouterConfig: () => mockGetNexusRouterConfig(),
}));

const mockResolveConnectorId = jest.fn();
jest.mock("@/lib/nexus/model-router/psd-data-connector", () => ({
  resolvePsdDataConnectorId: (...args: unknown[]) =>
    mockResolveConnectorId(...args),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "artifact-query-request-id",
  getLogContext: () => ({ requestId: "artifact-query-request-id" }),
  sanitizeForLogging: (value: unknown) => value,
  startTimer: () => jest.fn(),
}));

import { queryArtifactData } from "@/actions/db/atrium/artifact-query";

const SESSION = { sub: "cognito-user-7", idToken: "id-token-abc" };
const REQUESTER = {
  kind: "user" as const,
  userId: 7,
  roles: ["staff"],
  building: null,
  department: null,
  gradeLevels: null,
  groups: [],
  isAdmin: false,
};
const CONTENT = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "artifact",
  dataAccess: "query",
  currentVersionId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: 7,
};
/** A non-head version of the SAME artifact (the /c/ + dropdown case, #1787). */
const OLDER_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

const JSON_BODY = {
  columns: ["school_name", "enrolled"],
  rows: [
    ["Peninsula HS", 1234],
    ["Gig Harbor HS", 1210],
  ],
  total_count: 2,
  returned_count: 2,
  limit: 2000,
  offset: 0,
  truncated: false,
};

const mockExecute = jest.fn();
const mockClose = jest.fn();

const validInput = {
  contentId: "enrollment-dashboard",
  sql: "SELECT school_name, COUNT(*) FROM enrollment GROUP BY school_name",
};

/** The forced-argument object the action must always send. */
function forcedArgs(): Record<string, unknown> {
  return expect.objectContaining({
    format: "json",
    export: false,
    view_results: true,
    reason: `atrium artifact ${CONTENT.id} v${CONTENT.currentVersionId}`,
  }) as unknown as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue({ ...SESSION });
  mockGetUserRequester.mockResolvedValue({ ...REQUESTER });
  mockContentGet.mockResolvedValue({ ...CONTENT });
  // Default to a NON-editor requester: upstream text must stay withheld unless
  // a test opts into the editor case.
  mockCanEdit.mockReturnValue(false);
  mockVersionGetById.mockResolvedValue(null);
  mockConsumeRateLimit.mockReturnValue({
    allowed: true,
    retryAfterSeconds: 0,
    resetTime: Date.now() + 60_000,
  });
  mockGetNexusRouterConfig.mockResolvedValue({
    config: { specialists: { psdDataConnectorName: "psd-data" } },
    mode: "active",
  });
  mockResolveConnectorId.mockResolvedValue(CONNECTOR_ID);
  mockClose.mockResolvedValue(undefined);
  mockExecute.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(JSON_BODY) }],
  });
  mockGetConnectorTools.mockResolvedValue({
    serverId: CONNECTOR_ID,
    serverName: "psd-data",
    tools: { query_data: { execute: mockExecute } },
    close: mockClose,
  });
});

describe("queryArtifactData happy path", () => {
  it("returns the parsed json body and always closes the connector", async () => {
    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toEqual({
      columns: ["school_name", "enrolled"],
      rows: [
        ["Peninsula HS", 1234],
        ["Gig Harbor HS", 1210],
      ],
      totalCount: 2,
      returnedCount: 2,
      limit: 2000,
      offset: 0,
      truncated: false,
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("passes the viewer's id token through to the connector", async () => {
    await queryArtifactData(validInput);

    expect(mockGetConnectorTools).toHaveBeenCalledWith(
      CONNECTOR_ID,
      REQUESTER.userId,
      REQUESTER.roles,
      { idToken: SESSION.idToken }
    );
  });

  it("forces format/export/view_results/reason and calls only query_data", async () => {
    await queryArtifactData(validInput);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      forcedArgs(),
      expect.anything()
    );
    const [args] = mockExecute.mock.calls[0] as [Record<string, unknown>];
    expect(args.sql_query).toBe(validInput.sql);
  });

  it("ignores page-supplied export/format/reason/tool overrides", async () => {
    await queryArtifactData({
      ...validInput,
      // Extra fields a hostile page might attach. The typed input has no such
      // members, so this documents the runtime behaviour at the boundary.
      ...({
        export: true,
        format: "csv",
        reason: "totally legitimate",
        tool: "save_lesson",
      } as unknown as Record<string, never>),
    });

    const [args] = mockExecute.mock.calls[0] as [Record<string, unknown>];
    expect(args.export).toBe(false);
    expect(args.format).toBe("json");
    expect(args.reason).toBe(
      `atrium artifact ${CONTENT.id} v${CONTENT.currentVersionId}`
    );
    expect(mockGetConnectorTools).toHaveBeenCalledTimes(1);
  });

  it("clamps limit to the json row cap and defaults offset to 0", async () => {
    await queryArtifactData({ ...validInput, limit: 99_999 });

    const [args] = mockExecute.mock.calls[0] as [Record<string, unknown>];
    expect(args.limit).toBe(2000);
    expect(args.offset).toBe(0);
  });
});

describe("queryArtifactData gates", () => {
  it("rejects an unauthenticated caller before any lookup", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("fails closed when the session carries no id token", async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: SESSION.sub });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("refuses an over-budget caller before requester or visibility lookups", async () => {
    mockConsumeRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterSeconds: 30,
      resetTime: Date.now() + 30_000,
    });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockGetUserRequester).not.toHaveBeenCalled();
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("keys the rate limit per viewer per artifact", async () => {
    await queryArtifactData(validInput);

    expect(mockConsumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "atrium-artifact-data-query",
        identifier: `user-sub:${SESSION.sub}:content:${validInput.contentId}`,
      })
    );
  });

  it("returns a 404-style failure for content the viewer cannot see", async () => {
    mockContentGet.mockRejectedValueOnce(
      new NotFoundError("Content not found", { idOrSlug: validInput.contentId })
    );

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(result.message).not.toMatch(/forbidden|permission/i);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it.each(["records", "none"] as const)(
    "refuses a %s-mode artifact without reaching the data MCP",
    async (dataAccess) => {
      mockContentGet.mockResolvedValueOnce({ ...CONTENT, dataAccess });

      const result = await queryArtifactData(validInput);

      expect(result.isSuccess).toBe(false);
      expect(mockGetConnectorTools).not.toHaveBeenCalled();
    }
  );

  it("refuses a document", async () => {
    mockContentGet.mockResolvedValueOnce({ ...CONTENT, kind: "document" });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("fails closed when the data connector is not configured", async () => {
    mockResolveConnectorId.mockResolvedValueOnce(null);

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("surfaces a connector access denial as a failure, not rows", async () => {
    // `getConnectorTools` runs requireUserAccess internally; a student or an
    // out-of-allow-list viewer throws there, before any MCP request is made.
    mockGetConnectorTools.mockRejectedValueOnce(
      new Error("User 7 does not have role-based access to MCP server x")
    );

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized SQL before any connector work", async () => {
    const empty = await queryArtifactData({ ...validInput, sql: "   " });
    const huge = await queryArtifactData({
      ...validInput,
      sql: "a".repeat(8_001),
    });

    expect(empty.isSuccess).toBe(false);
    expect(huge.isSuccess).toBe(false);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("rejects a negative offset", async () => {
    const result = await queryArtifactData({ ...validInput, offset: -1 });

    expect(result.isSuccess).toBe(false);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });
});

describe("queryArtifactData upstream failures", () => {
  it("treats an isError tool result as a failure", async () => {
    mockExecute.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "relation \"secret\" does not exist" }],
    });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(result.message).not.toMatch(/secret/);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("rejects an unparseable body rather than returning partial rows", async () => {
    mockExecute.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
    });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
  });

  it("fails instead of wrapping row-objects into one-cell tuples", async () => {
    mockExecute.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...JSON_BODY,
            rows: [{ school_name: "Peninsula HS", enrolled: 1234 }],
          }),
        },
      ],
    });

    const result = await queryArtifactData(validInput);

    // A "successful" result whose cells after the first read `undefined` is
    // silent corruption; the bridge must report a failure instead.
    expect(result.isSuccess).toBe(false);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("fails on a ragged row rather than returning a partial tuple", async () => {
    mockExecute.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...JSON_BODY,
            rows: [["Peninsula HS", 1234], ["Gig Harbor HS"]],
          }),
        },
      ],
    });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
  });

  it("fails on a non-string column name rather than coercing it", async () => {
    mockExecute.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...JSON_BODY,
            columns: [{ name: "school_name" }, "enrolled"],
          }),
        },
      ],
    });

    const result = await queryArtifactData(validInput);

    // String() would have handed the page a header reading "[object Object]"
    // as though the query had succeeded.
    expect(result.isSuccess).toBe(false);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("closes the connector when the tool call throws", async () => {
    mockExecute.mockRejectedValueOnce(new Error("upstream timeout"));

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("fails when the connector does not expose query_data", async () => {
    mockGetConnectorTools.mockResolvedValueOnce({
      serverId: CONNECTOR_ID,
      serverName: "psd-data",
      tools: { save_lesson: { execute: mockExecute } },
      close: mockClose,
    });

    const result = await queryArtifactData(validInput);

    expect(result.isSuccess).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1787 — every failure carries a typed `code`, and the data MCP's own text is
 * kept (logged always, forwarded only to someone who can edit the artifact).
 */
/** Narrow an outcome to its failure arm, shared by the failure suites. */
function failureOf(result: Awaited<ReturnType<typeof queryArtifactData>>) {
  if (result.isSuccess) throw new Error("expected a failure");
  return result;
}

describe("queryArtifactData typed failure codes (#1787)", () => {
  /** Narrow the outcome to its failure arm so `code` is readable. */

  it("classifies a missing session as unauthenticated", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    expect(failureOf(await queryArtifactData(validInput)).code).toBe(
      "unauthenticated"
    );
  });

  it("classifies a session with no id token as unauthenticated", async () => {
    mockGetServerSession.mockResolvedValueOnce({ sub: SESSION.sub });
    expect(failureOf(await queryArtifactData(validInput)).code).toBe(
      "unauthenticated"
    );
  });

  it("classifies the 404 mask as forbidden", async () => {
    mockContentGet.mockRejectedValueOnce(new NotFoundError("Content not found"));
    expect(failureOf(await queryArtifactData(validInput)).code).toBe("forbidden");
  });

  it("classifies a connector access denial as forbidden", async () => {
    mockGetConnectorTools.mockRejectedValueOnce(
      new Error("User 7 does not have role-based access to MCP server x")
    );
    expect(failureOf(await queryArtifactData(validInput)).code).toBe("forbidden");
  });

  it.each(["records", "none"] as const)(
    "classifies a %s-mode artifact as not_query_mode, not a query error",
    async (dataAccess) => {
      mockContentGet.mockResolvedValueOnce({ ...CONTENT, dataAccess });
      expect(failureOf(await queryArtifactData(validInput)).code).toBe(
        "not_query_mode"
      );
    }
  );

  it("classifies an exhausted budget as rate_limited and carries the retry delay", async () => {
    mockConsumeRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterSeconds: 30,
      resetTime: Date.now() + 30_000,
    });

    const failure = failureOf(await queryArtifactData(validInput));

    expect(failure.code).toBe("rate_limited");
    expect(failure.retryAfterSeconds).toBe(30);
  });

  it("classifies an unconfigured connector as unavailable", async () => {
    mockResolveConnectorId.mockResolvedValueOnce(null);
    expect(failureOf(await queryArtifactData(validInput)).code).toBe("unavailable");
  });

  it("classifies an aborted/timed-out tool call as timeout", async () => {
    const aborted = new Error("The operation was aborted due to timeout");
    aborted.name = "TimeoutError";
    mockExecute.mockRejectedValueOnce(aborted);
    expect(failureOf(await queryArtifactData(validInput)).code).toBe("timeout");
  });

  it("classifies a malformed upstream body as unavailable, not a query error", async () => {
    mockExecute.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
    });
    expect(failureOf(await queryArtifactData(validInput)).code).toBe("unavailable");
  });
});

/**
 * #1788: the 30s budget used to start at `execute()`, so a slow connector
 * handshake was FREE — the real server-side worst case ran past the sandbox
 * host's 45s clock, and the page gave up on a query that was still running. The
 * budget now spans `getConnectorTools` too, so the server always loses the race.
 */
describe("queryArtifactData overall deadline (#1788)", () => {
  it("times out a handshake that never settles, and closes a late connector", async () => {
    jest.useFakeTimers();
    let settleConnector: (value: unknown) => void = () => undefined;
    mockGetConnectorTools.mockImplementationOnce(
      () => new Promise((resolve) => (settleConnector = resolve))
    );

    const pending = queryArtifactData(validInput);
    await jest.advanceTimersByTimeAsync(31_000);
    const result = await pending;

    expect(failureOf(result).code).toBe("timeout");
    expect(mockExecute).not.toHaveBeenCalled();

    // A connector that arrives after the caller gave up must not be leaked.
    settleConnector({
      serverId: CONNECTOR_ID,
      serverName: "psd-data",
      tools: { query_data: { execute: mockExecute } },
      close: mockClose,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(mockClose).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("gives the tool call the REMAINING budget, not a fresh one", async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockGetConnectorTools.mockImplementationOnce(async () => {
      // A handshake that eats 20s of the 30s budget.
      await jest.advanceTimersByTimeAsync(20_000);
      return {
        serverId: CONNECTOR_ID,
        serverName: "psd-data",
        tools: { query_data: { execute: mockExecute } },
        close: mockClose,
      };
    });
    mockExecute.mockImplementationOnce(
      async (_args: unknown, options: { abortSignal: AbortSignal }) => {
        capturedSignal = options.abortSignal;
        await jest.advanceTimersByTimeAsync(11_000);
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
    );

    const result = await queryArtifactData(validInput);

    expect(failureOf(result).code).toBe("timeout");
    expect(capturedSignal?.aborted).toBe(true);
    jest.useRealTimers();
  });
});

describe("queryArtifactData disclosure gate (#1787)", () => {
  it("gives an EDITOR the database's own message for a query_error", async () => {
    mockCanEdit.mockReturnValue(true);
    mockExecute.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: 'column "school_name" does not exist' }],
    });

    const failure = failureOf(await queryArtifactData(validInput));

    expect(failure.code).toBe("query_error");
    expect(failure.detail).toBe('column "school_name" does not exist');
    expect(failure.message).toContain('column "school_name" does not exist');
  });

  it("withholds the database text from a NON-editor", async () => {
    mockCanEdit.mockReturnValue(false);
    mockExecute.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: 'column "school_name" does not exist' }],
    });

    const failure = failureOf(await queryArtifactData(validInput));

    expect(failure.code).toBe("query_error");
    expect(failure.detail).toBeUndefined();
    expect(failure.message).not.toMatch(/school_name/);
  });

  it("gives a NON-editor this server's own message about their malformed request", async () => {
    mockCanEdit.mockReturnValue(false);

    const failure = failureOf(await queryArtifactData({ ...validInput, offset: -1 }));

    // Text this server wrote about the page's own request, never upstream text —
    // so it is not gated on edit rights the way the database's message is.
    expect(failure.code).toBe("query_error");
    expect(failure.detail).toEqual(expect.any(String));
    expect(failure.message).toBe(failure.detail);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });

  it("flattens control characters out of an upstream message", async () => {
    mockCanEdit.mockReturnValue(true);
    mockExecute.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "syntax error\nLINE 1: SELEC\n  ^" }],
    });

    const failure = failureOf(await queryArtifactData(validInput));

    expect(failure.detail).toBe("syntax error LINE 1: SELEC ^");
  });

  it("never leaks upstream text to an editor through a non-query failure", async () => {
    mockCanEdit.mockReturnValue(true);
    mockGetConnectorTools.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 10.0.0.1:443")
    );

    const failure = failureOf(await queryArtifactData(validInput));

    expect(failure.code).toBe("unavailable");
    expect(failure.detail).toBeUndefined();
    expect(failure.message).not.toMatch(/ECONNREFUSED/);
  });
});

/** #1787 — the audit line must name the version that is actually running. */
describe("queryArtifactData audit version (#1787)", () => {
  function reasonOf(): string {
    const [args] = mockExecute.mock.calls[0] as [Record<string, unknown>];
    return args.reason as string;
  }

  it("names the head when no version is supplied, without a lookup", async () => {
    await queryArtifactData(validInput);

    expect(reasonOf()).toBe(
      `atrium artifact ${CONTENT.id} v${CONTENT.currentVersionId}`
    );
    expect(mockVersionGetById).not.toHaveBeenCalled();
  });

  it("skips the lookup when the supplied version IS the head", async () => {
    await queryArtifactData({
      ...validInput,
      versionId: CONTENT.currentVersionId,
    });

    expect(mockVersionGetById).not.toHaveBeenCalled();
    expect(reasonOf()).toBe(
      `atrium artifact ${CONTENT.id} v${CONTENT.currentVersionId}`
    );
  });

  it("names a non-head version that belongs to this artifact", async () => {
    mockVersionGetById.mockResolvedValueOnce({ id: OLDER_VERSION_ID });

    await queryArtifactData({ ...validInput, versionId: OLDER_VERSION_ID });

    expect(mockVersionGetById).toHaveBeenCalledWith(CONTENT.id, OLDER_VERSION_ID);
    expect(reasonOf()).toBe(`atrium artifact ${CONTENT.id} v${OLDER_VERSION_ID}`);
  });

  it("falls back to the head when the version lookup itself fails", async () => {
    // The lookup only picks the audit line's version; a DB blip there must not
    // block a healthy query (#1787).
    mockVersionGetById.mockRejectedValueOnce(new Error("connection reset"));

    const result = await queryArtifactData({ ...validInput, versionId: OLDER_VERSION_ID });

    expect(result.isSuccess).toBe(true);
    expect(reasonOf()).toBe(`atrium artifact ${CONTENT.id} v${CONTENT.currentVersionId}`);
  });

  it("refuses a version that does not belong to this artifact", async () => {
    // `versionService.getById` is scoped by objectId, so a null answer means the
    // id belongs to some other object (or nothing) — never audit under it.
    mockVersionGetById.mockResolvedValueOnce(null);

    const result = await queryArtifactData({
      ...validInput,
      versionId: "55555555-5555-4555-8555-555555555555",
    });

    expect(result.isSuccess).toBe(false);
    expect(mockGetConnectorTools).not.toHaveBeenCalled();
  });
});
