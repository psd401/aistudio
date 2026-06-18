/**
 * Agent tool: `web.fetch` (Issue #926).
 *
 * Fetches a single public web page and returns its readable text. Bounded and
 * SSRF-guarded: HTTPS-only in production, private/loopback/link-local/metadata
 * hosts rejected, response size + duration capped, content type restricted to
 * text-ish payloads. HTML is reduced to text with a dependency-free pass (scripts
 * and styles removed, tags stripped, entities decoded, whitespace collapsed) so
 * the app gains no new HTML-parser dependency.
 */

import type { McpToolHandler, McpToolResult } from "@/lib/mcp/types";
import { createLogger } from "@/lib/logger";

const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 100_000;
/** Cap the raw body we read so a huge page can't exhaust memory. */
const MAX_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 10_000;

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** True for an IPv4 literal in a private / loopback / link-local range. */
function isPrivateIpv4(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local incl. AWS IMDS 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** True for an IPv6 loopback / unique-local / link-local / IPv4-mapped literal. */
function isPrivateIpv6(host: string): boolean {
  return (
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80") ||
    host.startsWith("::ffff:")
  );
}

/** True for a host we must never fetch (internal name or private address). */
function isBlockedHost(host: string): boolean {
  return (
    host === "metadata.google.internal" ||
    host === "localhost" ||
    isPrivateIpv6(host) ||
    isPrivateIpv4(host)
  );
}

/**
 * Reject URLs that target private, loopback, link-local, or cloud-metadata hosts
 * (SSRF guard). Mirrors the host checks in `lib/mcp/connector-service.ts`
 * (`rejectUnsafeMcpUrl`) but is self-contained so this handler does not pull the
 * MCP client graph. Hostname-only (DNS rebinding is not mitigated here, same as
 * the connector guard). Throws on an unsafe or malformed URL.
 */
export function assertSafeFetchUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  const isProd = process.env.NODE_ENV === "production";
  const protocolAllowed =
    url.protocol === "https:" || (url.protocol === "http:" && !isProd);
  if (!protocolAllowed) {
    throw new Error(
      isProd ? "Only https:// URLs are allowed" : "Only http(s):// URLs are allowed"
    );
  }

  // URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]"); strip them
  // so the IPv6 checks match.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHost(host)) {
    throw new Error("Refusing to fetch a private/loopback/internal host");
  }

  return url;
}

/** Decode the small set of HTML entities a tags-stripped page commonly contains. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    apos: "'",
    nbsp: " ",
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code in named) return named[code];
    if (code[0] === "#") {
      const cp =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
}

/** Reduce an HTML document to readable text without an HTML-parser dependency. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Drop entire script/style/noscript/template blocks (content + tags).
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
      // Turn common block boundaries into newlines so structure survives.
      .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Strip all remaining tags.
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+| [ \t]+$/gm, "")
    .trim();
}

/** True for a content type whose body is safe to return as text. */
function isTextualContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType === ""
  );
}

/** Read a fetched response into bounded, readable text. */
async function readResponseText(res: Response, maxChars: number): Promise<string> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!isTextualContentType(contentType)) {
    throw new Error(
      `non-text content (content-type: ${contentType || "unknown"})`
    );
  }
  const raw = await res.text();
  const bounded = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
  const isHtml = contentType.includes("html") || /<html[\s>]/i.test(bounded);
  const text = isHtml ? htmlToText(bounded) : bounded.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

function resolveMaxChars(value: unknown): number {
  const n = typeof value === "number" && value > 0 ? Math.floor(value) : DEFAULT_MAX_CHARS;
  return Math.min(HARD_MAX_CHARS, n);
}

export const handleWebFetch: McpToolHandler = async (args, context) => {
  const log = createLogger({ requestId: context.requestId, action: "agent.web_fetch" });
  const rawUrl = typeof args.url === "string" ? args.url : "";
  if (!rawUrl) {
    return textResult("Missing required field: url", true);
  }
  const maxChars = resolveMaxChars(args.maxChars);

  let url: URL;
  try {
    url = assertSafeFetchUrl(rawUrl);
  } catch (err) {
    return textResult(
      `Cannot fetch "${rawUrl}": ${err instanceof Error ? err.message : "blocked"}`,
      true
    );
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: { Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
    });
    if (!res.ok) {
      return textResult(`Fetch failed: HTTP ${res.status} ${res.statusText}`, true);
    }

    const text = await readResponseText(res, maxChars);
    log.info("Agent web fetch completed", {
      host: url.hostname,
      status: res.status,
      chars: text.length,
    });
    return textResult(
      `Fetched ${url.href} (${res.status})\n\n${text || "[no readable text content]"}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Agent web fetch failed", { host: url.hostname, error: message });
    const friendly =
      err instanceof Error && err.name === "TimeoutError"
        ? "request timed out"
        : message;
    return textResult(`Failed to fetch "${url.href}": ${friendly}`, true);
  }
};
