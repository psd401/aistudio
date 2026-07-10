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
export const MAX_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Cap redirect hops; each hop's target is re-validated by the SSRF guard. */
const MAX_REDIRECTS = 5;

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

/**
 * If `host` is an IPv4-compatible IPv6 literal (::/96, e.g. Node normalizes
 * "::127.0.0.1" to the compressed hex "::7f00:1"), return the embedded IPv4 in
 * dotted form; otherwise null. Excludes the ::ffff: IPv4-*mapped* range (handled
 * by prefix) and the bare "::"/"::1" forms (handled in isPrivateIpv6). (COR-506)
 */
function embeddedIpv4FromCompatibleV6(host: string): string | null {
  // 1–2 trailing 16-bit hex groups after "::" and nothing else. WHATWG URL emits
  // the IPv4-compatible tail as hex groups, so reconstruct the 32-bit v4 from them.
  const two = host.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const one = host.match(/^::([0-9a-f]{1,4})$/);
  let hi: number;
  let lo: number;
  if (two) {
    hi = Number.parseInt(two[1], 16);
    lo = Number.parseInt(two[2], 16);
  } else if (one) {
    hi = 0;
    lo = Number.parseInt(one[1], 16);
  } else {
    return null;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xFF}.${hi & 0xFF}.${(lo >> 8) & 0xFF}.${lo & 0xFF}`;
}

/** True for an IPv6 loopback / unique-local / link-local / IPv4-mapped literal. */
function isPrivateIpv6(host: string): boolean {
  if (
    host === "::1" ||
    // Unspecified address; connecting to :: reaches localhost on many stacks.
    // (COR-506)
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    // Link-local fe80::/10 spans the fe80–febf prefixes, not just fe80.
    // (Correctness review.)
    /^fe[89ab]/.test(host) ||
    // Any IPv4-mapped form. URL normalizes full-form (0:0:0:0:0:ffff:…) to this
    // compressed prefix, so this also blocks ::ffff:<private-or-public-v4>.
    host.startsWith("::ffff:")
  ) {
    return true;
  }
  // IPv4-compatible IPv6 (::a.b.c.d, deprecated but still parsed/routed). Node
  // normalizes these to compressed hex (e.g. "::7f00:1" for "::127.0.0.1"); the
  // last 32 bits are an IPv4 address — evaluate it against the private ranges so
  // "::127.0.0.1" is blocked while a public "::8.8.8.8" is not. (COR-506)
  const v4 = embeddedIpv4FromCompatibleV6(host);
  return v4 !== null && isPrivateIpv4(v4);
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
      // Handle an UNCLOSED script/style/etc block (malformed HTML): strip from the
      // opening tag to end-of-input so its raw content can't leak as text.
      // (Correctness review.)
      .replace(/<(script|style|noscript|template)\b[\s\S]*$/gi, " ")
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

/**
 * Read a response body as a stream, stopping once `maxBytes` have been read, so
 * peak memory is bounded to ~`maxBytes` regardless of what the server sends
 * (REV-COR-500). Falls back to `res.text()` only when no stream body is present
 * (e.g. 204s or test doubles), still bounding the returned length.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - received;
    if (value.byteLength >= room) {
      // Decode only up to the cap, then stop reading and release the stream.
      out += decoder.decode(value.subarray(0, room));
      await reader.cancel();
      return out;
    }
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode(); // flush any trailing multi-byte sequence
  return out;
}

/** Read a fetched response into bounded, readable text. */
export async function readResponseText(res: Response, maxChars: number): Promise<string> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!isTextualContentType(contentType)) {
    throw new Error(
      `non-text content (content-type: ${contentType || "unknown"})`
    );
  }
  // Fast reject: an advertised Content-Length over the cap, before reading a
  // single body byte (REV-COR-500).
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    throw new Error(
      `response too large (content-length ${declaredLength} > ${MAX_BYTES} bytes)`
    );
  }

  const bounded = await readBoundedText(res, MAX_BYTES);
  // Bound the working set BEFORE the expensive htmlToText passes (REV-PERF-005):
  // HTML markup expands relative to visible text, so maxChars*8 (capped at
  // MAX_BYTES) keeps enough source to still yield `maxChars` readable characters
  // while limiting the regex passes to a few hundred KB instead of up to 5 MB.
  const budget = Math.min(MAX_BYTES, maxChars * 8);
  const workInput = bounded.length > budget ? bounded.slice(0, budget) : bounded;
  const isHtml = contentType.includes("html") || /<html[\s>]/i.test(workInput);
  const text = isHtml ? htmlToText(workInput) : workInput.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

function resolveMaxChars(value: unknown): number {
  const n = typeof value === "number" && value > 0 ? Math.floor(value) : DEFAULT_MAX_CHARS;
  return Math.min(HARD_MAX_CHARS, n);
}

/**
 * Fetch `url`, following up to MAX_REDIRECTS redirects MANUALLY so every hop's
 * target is re-validated by assertSafeFetchUrl. undici's redirect:"follow" would
 * jump to an internal host (a 302 to 169.254.170.2 / localhost / a VPC service)
 * without re-running the SSRF guard, turning this tool into an internal-read
 * primitive (REV-COR-496). A single shared AbortSignal bounds the whole chain to
 * FETCH_TIMEOUT_MS. Returns the final non-redirect Response; throws on a blocked
 * redirect target, an invalid Location, or exceeding the hop cap.
 */
async function fetchWithGuardedRedirects(url: URL, signal: AbortSignal): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(currentUrl, {
      signal,
      redirect: "manual",
      headers: { Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
    });

    const isRedirect =
      res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;

    // Free the redirect response's socket before the next hop.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
    }

    const location = res.headers.get("location") || "";
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl); // resolve a relative Location
    } catch {
      throw new Error(`invalid redirect target "${location}"`);
    }
    // Re-validate the redirect target's protocol + host (SSRF guard). Throws if
    // the hop points at a private/loopback/internal host.
    currentUrl = assertSafeFetchUrl(nextUrl.href);
  }
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
    const res = await fetchWithGuardedRedirects(
      url,
      AbortSignal.timeout(FETCH_TIMEOUT_MS)
    );
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
