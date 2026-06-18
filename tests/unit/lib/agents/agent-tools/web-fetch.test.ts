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
