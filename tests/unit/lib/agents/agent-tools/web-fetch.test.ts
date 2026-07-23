/**
 * @jest-environment node
 *
 * Agent `web.fetch` tool (Issue #926): SSRF guard, HTML→text reduction, and the
 * handler's response handling. Uses the global `jest` (not @jest/globals).
 */

import {
  assertSafeFetchUrl,
  htmlToText,
  handleWebFetch,
  readResponseText,
  MAX_BYTES,
} from "@/lib/agents/agent-tools/web-fetch";
import type { McpToolContext } from "@/lib/mcp/types";

const ctx: McpToolContext = {
  userId: 1,
  cognitoSub: "sub",
  scopes: ["chat:write"],
  requestId: "req-1",
};

function withNodeEnv(value: string, fn: () => void) {
  const original = process.env.NODE_ENV;
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: original,
      configurable: true,
    });
  }
}

describe("assertSafeFetchUrl", () => {
  it("allows a public https URL", () => {
    expect(assertSafeFetchUrl("https://example.com/page").hostname).toBe(
      "example.com"
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSafeFetchUrl("not a url")).toThrow(/Invalid URL/);
  });

  it.each([
    "http://localhost/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://192.168.0.1/x",
    "https://172.16.5.5/x",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/x",
    "https://[::1]/x",
    // IPv4-mapped IPv6 loopback, compressed and full form (URL normalizes both to
    // ::ffff:7f00:1, caught by the ::ffff: prefix). (Correctness review.)
    "https://[::ffff:127.0.0.1]/x",
    "https://[0:0:0:0:0:ffff:127.0.0.1]/x",
    // Link-local fe80::/10 beyond the fe80 prefix (fe9x/feax/febx).
    "https://[fe9a::1]/x",
    "https://[feba::1]/x",
  ])("blocks private/internal target %s", (url) => {
    expect(() => assertSafeFetchUrl(url)).toThrow(/private|loopback|internal/i);
  });

  // REV-COR-506: IPv6 unspecified + IPv4-compatible gaps. Node normalizes
  // "[::127.0.0.1]" to the compressed hex "::7f00:1", so the guard must decode
  // the embedded IPv4 rather than match dotted digits.
  it.each([
    "https://[::]/x", // unspecified address → localhost on many stacks
    "https://[::127.0.0.1]/x", // IPv4-compatible → normalizes to ::7f00:1
  ])("blocks IPv6 gap target %s", (url) => {
    expect(() => assertSafeFetchUrl(url)).toThrow(/private|loopback|internal/i);
  });

  it("still allows a public IPv6 literal", () => {
    expect(
      assertSafeFetchUrl("https://[2606:4700:4700::1111]/x").hostname
    ).toBe("[2606:4700:4700::1111]");
  });

  it("rejects http in production but allows it in dev", () => {
    withNodeEnv("production", () => {
      expect(() => assertSafeFetchUrl("http://example.com")).toThrow(/https/);
    });
    withNodeEnv("development", () => {
      expect(assertSafeFetchUrl("http://example.com").protocol).toBe("http:");
    });
  });
});

describe("htmlToText", () => {
  it("strips script/style blocks and tags, decodes entities", () => {
    const html =
      "<html><head><style>.x{}</style></head><body>" +
      "<script>alert(1)</script><h1>Title</h1><p>Hello &amp; welcome</p>" +
      "<div>Line&nbsp;two</div></body></html>";
    const text = htmlToText(html);
    expect(text).not.toMatch(/alert/);
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toContain("Title");
    expect(text).toContain("Hello & welcome");
    expect(text).toContain("Line two");
  });

  it("strips an UNCLOSED script block (malformed HTML) to end of input", () => {
    const html = "<body><p>Visible</p><script>secret = leak()";
    const text = htmlToText(html);
    expect(text).toContain("Visible");
    expect(text).not.toMatch(/secret/);
    expect(text).not.toMatch(/leak/);
  });
});

describe("handleWebFetch", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns an error for a missing url", async () => {
    const res = await handleWebFetch({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Missing required field: url/);
  });

  it("returns an error (not a throw) for a blocked url", async () => {
    const res = await handleWebFetch({ url: "https://127.0.0.1/secret" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Cannot fetch/);
  });

  it("fetches and returns readable text for an html page", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/html"]]),
      text: async () => "<html><body><p>Doc body</p></body></html>",
    } as unknown as Response);

    const res = await handleWebFetch({ url: "https://example.com/doc" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Doc body");
    expect(res.content[0].text).toContain("https://example.com/doc");
  });

  it("returns an error for a non-OK HTTP status", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Map(),
      text: async () => "",
    } as unknown as Response);

    const res = await handleWebFetch({ url: "https://example.com/missing" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/HTTP 404/);
  });

  it("refuses non-text content types", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "application/octet-stream"]]),
      text: async () => "binary",
    } as unknown as Response);

    const res = await handleWebFetch({ url: "https://example.com/bin" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/non-text content/);
  });

  it("truncates output to maxChars", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "x".repeat(5000),
    } as unknown as Response);

    const res = await handleWebFetch(
      { url: "https://example.com/long", maxChars: 100 },
      ctx
    );
    expect(res.content[0].text).toMatch(/…\[truncated\]/);
  });
});

describe("handleWebFetch redirect guard (REV-COR-496)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const redirectTo = (location: string, status = 302) =>
    ({
      ok: false,
      status,
      statusText: "Found",
      headers: new Map([["location", location]]),
    }) as unknown as Response;

  const ok200Html = (body: string) =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/html"]]),
      text: async () => body,
    }) as unknown as Response;

  it.each([
    "http://169.254.170.2/v2/credentials/abc", // ECS task-role credential endpoint
    "http://169.254.169.254/latest/meta-data/", // EC2 IMDS
    "http://localhost:8080/internal",
  ])(
    "refuses a redirect to internal host %s and never returns its body",
    async (target) => {
      // If the guard were bypassed, the second hop would fetch the internal host
      // and its body would be returned. Stub that body with a unique sentinel and
      // assert it never appears — and that the internal host was never fetched.
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(redirectTo(target))
        .mockResolvedValueOnce(ok200Html("SECRET_INTERNAL_BODY_9c3f"));
      global.fetch = fetchMock;
      const res = await handleWebFetch({ url: "https://example.com/start" }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).not.toContain("SECRET_INTERNAL_BODY_9c3f");
      // Only the first (public) hop was fetched; the internal host never was.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("follows a legitimate http→https redirect on a public host and returns text", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(redirectTo("https://example.com/final", 301))
      .mockResolvedValueOnce(ok200Html("<p>Final page</p>"));
    const res = await handleWebFetch({ url: "http://example.com/start" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Final page");
  });

  it("bounds redirect hops and errors on an over-limit chain (no hang)", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(redirectTo("https://example.com/loop"));
    global.fetch = fetchMock;
    const res = await handleWebFetch({ url: "https://example.com/loop" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/too many redirects/i);
    // MAX_REDIRECTS = 5 → 6 fetches (hops 0..5) then bail.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("readResponseText byte cap (REV-COR-500)", () => {
  it("stops reading at MAX_BYTES and cancels the stream", async () => {
    const CHUNK = 1_000_000;
    let enqueued = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = {
      headers: new Map([["content-type", "text/plain"]]),
      body: stream,
    } as unknown as Response;

    const text = await readResponseText(res, 20_000);
    expect(cancelled).toBe(true);
    // Read at most the cap plus the single straddling chunk.
    expect(enqueued).toBeLessThanOrEqual(MAX_BYTES + CHUNK);
    expect(text.length).toBeLessThanOrEqual(20_020);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    // A ReadableStream calls `pull` eagerly on construction, so instrument the
    // body's getReader instead: it must never be called — the content-length
    // check rejects before any body access.
    let readerCreated = false;
    const res = {
      headers: new Map<string, string>([
        ["content-type", "text/plain"],
        ["content-length", String(MAX_BYTES + 1)],
      ]),
      body: {
        getReader() {
          readerCreated = true;
          return new ReadableStream<Uint8Array>().getReader();
        },
      },
    } as unknown as Response;

    await expect(readResponseText(res, 20_000)).rejects.toThrow(
      /too large|content-length/i
    );
    expect(readerCreated).toBe(false);
  });
});

describe("htmlToText input bounding (REV-PERF-005)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("normalizes only a bounded slice of a large HTML body, not the full read", async () => {
    const maxChars = 1000; // input budget = maxChars * 8 = 8000 chars
    // ~9000 chars of HTML comments (each stripped to a space) push ENDMARKER
    // past the 8000-char input budget. Visible text stays well under maxChars so
    // the char cap does NOT fire — if ENDMARKER is absent it was cut at the INPUT
    // boundary, proving normalization ran on the bounded slice, not the full 5 MB.
    const filler = "<!-- x -->".repeat(900); // 9000 chars
    const html = `<p>START</p>${filler}<p>ENDMARKER</p>`;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/html"]]),
      text: async () => html,
    } as unknown as Response);

    const res = await handleWebFetch(
      { url: "https://example.com/big", maxChars },
      ctx
    );
    expect(res.content[0].text).toContain("START");
    expect(res.content[0].text).not.toContain("ENDMARKER");
  });
});
