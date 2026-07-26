import { describe, expect, it } from "bun:test";
import {
  buildOAuth1Header,
  OneRosterClient,
  RevisionChangedError,
  type HttpResponse,
  type HttpTransport,
} from "./oneroster-client";

class TestHeaders {
  private readonly values: Map<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.values = new Map(
      Object.entries(values).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ])
    );
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): HttpResponse {
  const responseHeaders =
    status >= 200 && status < 300
      ? { "x-perm-rev": "rev-1", ...headers }
      : headers;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new TestHeaders(responseHeaders),
    json: async () => body,
  };
}

function proxyClient(
  transport: HttpTransport,
  overrides: {
    pageSize?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
  } = {}
): OneRosterClient {
  return new OneRosterClient({
    baseUrl: "https://district.example",
    apiVersion: "v1p1",
    pageSize: overrides.pageSize ?? 10_000,
    credentials: { mode: "proxy", bearerToken: "static-token" },
    transport,
    sleep: overrides.sleep,
    random: overrides.random,
  });
}

describe("OneRosterClient authentication", () => {
  it("signs the complete OAuth1 URL query with HMAC-SHA1", () => {
    const base = {
      method: "GET" as const,
      consumerKey: "consumer",
      consumerSecret: "secret",
      timestamp: 1_700_000_000,
      nonce: "fixed-nonce",
    };
    const first = buildOAuth1Header({
      ...base,
      url: "https://district.example/ims/oneroster/v1p1/users?limit=10000&offset=0",
    });
    const second = buildOAuth1Header({
      ...base,
      url: "https://district.example/ims/oneroster/v1p1/users?limit=10000&offset=10000",
    });

    expect(first).toContain('oauth_consumer_key="consumer"');
    expect(first).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(first).not.toEqual(second);
  });

  it("uses the configured non-expiring proxy bearer token directly", async () => {
    let authorization = "";
    const client = proxyClient(async (_url, init) => {
      authorization = init.headers.Authorization ?? "";
      return response(200, { orgs: [] }, { "x-total-count": "0" });
    });

    await client.fetchCollection("orgs", null);

    expect(authorization).toBe("Bearer static-token");
  });
});

describe("OneRosterClient paging and consistency", () => {
  it("pages bulk collections using limit, offset, fields, x-count, and x-total-count", async () => {
    const urls: string[] = [];
    const client = proxyClient(
      async (rawUrl) => {
        urls.push(rawUrl);
        const offset = new URL(rawUrl).searchParams.get("offset");
        return offset === "0"
          ? response(
              200,
              { users: [{ sourcedId: "u1" }, { sourcedId: "u2" }] },
              {
                "x-count": "2",
                "x-total-count": "3",
                "x-perm-rev": "rev-1",
              }
            )
          : response(
              200,
              { users: [{ sourcedId: "u3" }] },
              {
                "x-count": "1",
                "x-total-count": "3",
                "x-perm-rev": "rev-1",
              }
            );
      },
      { pageSize: 2 }
    );

    const result = await client.fetchCollection("users", null);

    expect(result.records.map((record) => record.sourcedId)).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0] ?? "").searchParams.get("limit")).toBe("2");
    expect(new URL(urls[1] ?? "").searchParams.get("offset")).toBe("2");
    expect(new URL(urls[0] ?? "").searchParams.get("fields")).toContain(
      "email"
    );
  });

  it("uses an empty page only as the fallback terminator when totals are absent", async () => {
    let requests = 0;
    const client = proxyClient(
      async () => {
        requests += 1;
        return requests === 1
          ? response(200, { orgs: [{ sourcedId: "o1" }, { sourcedId: "o2" }] })
          : response(200, { orgs: [] });
      },
      { pageSize: 2 }
    );

    const result = await client.fetchCollection("orgs", null);

    expect(result.records).toHaveLength(2);
    expect(requests).toBe(2);
  });

  it("rejects a premature empty page, inconsistent count, and excess total", async () => {
    const premature = proxyClient(async () =>
      response(200, { courses: [] }, { "x-total-count": "1" })
    );
    const badCount = proxyClient(async () =>
      response(
        200,
        { courses: [{ sourcedId: "c1" }] },
        { "x-count": "2" }
      )
    );
    const excess = proxyClient(async () =>
      response(
        200,
        { courses: [{ sourcedId: "c1" }, { sourcedId: "c2" }] },
        { "x-total-count": "1" }
      )
    );

    await expect(premature.fetchCollection("courses", null)).rejects.toThrow(
      "before x-total-count"
    );
    await expect(badCount.fetchCollection("courses", null)).rejects.toThrow(
      "inconsistent x-count"
    );
    await expect(excess.fetchCollection("courses", null)).rejects.toThrow(
      "more records"
    );
  });

  it("aborts staged data when x-perm-rev changes between pages", async () => {
    let requests = 0;
    const client = proxyClient(
      async () => {
        requests += 1;
        return response(
          200,
          requests === 1
            ? { classes: [{ sourcedId: "c1" }] }
            : { classes: [{ sourcedId: "c2" }] },
          {
            "x-total-count": "2",
            "x-perm-rev": requests === 1 ? "rev-1" : "rev-2",
          }
        );
      },
      { pageSize: 1 }
    );

    await expect(
      client.fetchCollection("classes", null)
    ).rejects.toBeInstanceOf(RevisionChangedError);
  });

  it("rejects a successful page without the consistency revision", async () => {
    const client = proxyClient(async () => ({
      ok: true,
      status: 200,
      headers: new TestHeaders(),
      json: async () => ({ orgs: [{ sourcedId: "o1" }] }),
    }));

    await expect(client.fetchCollection("orgs", null)).rejects.toThrow(
      "missing x-perm-rev"
    );
  });

  it("short-circuits the full pull when the persistent revision is unchanged", async () => {
    let requests = 0;
    const client = proxyClient(async () => {
      requests += 1;
      return response(
        200,
        { orgs: [{ sourcedId: "o1" }] },
        { "x-total-count": "1", "x-perm-rev": "same-rev" }
      );
    });

    const result = await client.pullAll("same-rev");

    expect(result.unchanged).toBe(true);
    expect(requests).toBe(1);
  });
});

describe("OneRosterClient transient retries", () => {
  it("retries 429 and 502 with Retry-After and capped exponential backoff", async () => {
    const delays: number[] = [];
    let requests = 0;
    const client = proxyClient(
      async () => {
        requests += 1;
        if (requests === 1) {
          return response(429, null, { "retry-after": "3" });
        }
        if (requests === 2) return response(502, null);
        return response(200, { enrollments: [] }, { "x-total-count": "0" });
      },
      {
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        random: () => 0,
      }
    );

    await client.fetchCollection("enrollments", null);

    expect(requests).toBe(3);
    expect(delays).toEqual([3_000, 2_000]);
  });

  it("does not retry non-transient HTTP errors", async () => {
    let requests = 0;
    const client = proxyClient(async () => {
      requests += 1;
      return response(401, null);
    });

    await expect(client.fetchCollection("users", null)).rejects.toThrow(
      "HTTP 401"
    );
    expect(requests).toBe(1);
  });
});
