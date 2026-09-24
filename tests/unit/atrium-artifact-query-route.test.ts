/**
 * `POST /api/atrium/artifacts/{id}/query` — the route that replaced the Server
 * Action transport for `AtriumData.query` (#1788).
 *
 * The route deliberately holds NO authorization logic of its own: it decodes the
 * transport envelope and calls `queryArtifactData`, so session resolution, the
 * 404 mask, the `data_access` mode check, the rate limit and the connector
 * access check cannot drift between the two entry points. These tests therefore
 * pin exactly what the route owns:
 *
 *  1. the base64 envelope (raw SQL in a body is what the edge WAF's `SQLi_BODY`
 *     rule blocks, with a 403 the app never sees),
 *  2. that the artifact id comes from the URL and nothing else,
 *  3. that each typed bridge code maps to a real HTTP status rather than a
 *     blanket 200 — an infrastructure failure has to stay distinguishable from
 *     an application answer,
 *  4. that a malformed envelope is refused before the action runs.
 */

const queryArtifactDataMock = jest.fn();

jest.mock("@/actions/db/atrium/artifact-query", () => ({
  queryArtifactData: (...args: unknown[]) => queryArtifactDataMock(...args),
}));

import type { NextRequest } from "next/server";
import { POST } from "@/app/api/atrium/artifacts/[id]/query/route";
import type { ArtifactBridgeErrorCode } from "@/lib/content/artifact-bridge-errors";

const CONTENT_ID = "11111111-2222-4333-8444-555555555555";

function request(body: unknown): NextRequest {
  return {
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("bad json");
      return body;
    },
  } as unknown as NextRequest;
}

function params(id = CONTENT_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function encoded(sql: string): string {
  return Buffer.from(sql, "utf8").toString("base64");
}

const SUCCESS = {
  isSuccess: true as const,
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
};

beforeEach(() => {
  queryArtifactDataMock.mockReset().mockResolvedValue(SUCCESS);
});

describe("POST /api/atrium/artifacts/[id]/query", () => {
  it("decodes the base64 SQL and takes the artifact id from the URL", async () => {
    const response = await POST(
      request({
        sqlBase64: encoded("SELECT school_name FROM schools"),
        limit: 25,
        offset: 10,
        versionId: "version-7",
        // A body field naming another artifact must NOT win over the URL.
        contentId: "attacker-chosen",
      }),
      params()
    );

    expect(queryArtifactDataMock).toHaveBeenCalledWith({
      contentId: CONTENT_ID,
      sql: "SELECT school_name FROM schools",
      limit: 25,
      offset: 10,
      versionId: "version-7",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SUCCESS);
  });

  it("passes non-numeric limit/offset through as absent, for the action to default", async () => {
    await POST(
      request({ sqlBase64: encoded("SELECT 1"), limit: "10", offset: null }),
      params()
    );

    expect(queryArtifactDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined, offset: undefined })
    );
  });

  it.each<[ArtifactBridgeErrorCode, number]>([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["not_query_mode", 409],
    ["rate_limited", 429],
    ["timeout", 504],
    ["query_error", 400],
    ["too_many_requests", 429],
    ["unavailable", 503],
  ])("answers %s with HTTP %i and the typed body", async (code, status) => {
    queryArtifactDataMock.mockResolvedValueOnce({
      isSuccess: false,
      code,
      message: `failed: ${code}`,
    });

    const response = await POST(
      request({ sqlBase64: encoded("SELECT 1") }),
      params()
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      isSuccess: false,
      code,
      message: `failed: ${code}`,
    });
  });

  it("carries retryAfterSeconds through for a rate limit", async () => {
    queryArtifactDataMock.mockResolvedValueOnce({
      isSuccess: false,
      code: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 12,
    });

    const response = await POST(
      request({ sqlBase64: encoded("SELECT 1") }),
      params()
    );

    await expect(response.json()).resolves.toMatchObject({
      retryAfterSeconds: 12,
    });
  });

  it("refuses an unparseable body before the action runs", async () => {
    const response = await POST(request("not json"), params());

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "query_error" });
  });

  it("refuses a missing sqlBase64 before the action runs", async () => {
    const response = await POST(request({ sql: "SELECT 1" }), params());

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("refuses SQL that is not valid base64 rather than decoding it leniently", async () => {
    // Node's Buffer.from(x, "base64") silently drops invalid characters, which
    // would turn a corrupted payload into garbled SQL the data MCP then reports
    // as a syntax error nobody can explain.
    const response = await POST(
      request({ sqlBase64: "SELECT * FROM schools" }),
      params()
    );

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("refuses an array body", async () => {
    const response = await POST(request([{ sqlBase64: encoded("SELECT 1") }]), params());

    expect(queryArtifactDataMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });
});
