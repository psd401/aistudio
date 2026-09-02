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
jest.mock("@/lib/content", () => ({
  contentService: {
    get: (...args: unknown[]) => mockContentGet(...args),
  },
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
};
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
    expect(Object.keys(mockGetConnectorTools.mock.calls).length).toBe(1);
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
