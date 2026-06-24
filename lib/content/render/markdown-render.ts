/**
 * Atrium markdown -> sanitized HTML render
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Converts a document's canonical
 * markdown into a sanitized HTML snapshot stored alongside the markdown in S3.
 *
 * Phase 0 goal: bodies (markdown source + a rendered HTML snapshot) persist to
 * S3, and the rendered HTML is safe to serve. The full templated render pipeline
 * (district stylesheet, directives, KaTeX) is Phase 1 (§18.2); this is the
 * minimal, safe renderer that satisfies the Phase 0 acceptance criterion and the
 * §31.1 sanitizer requirement ("`<script>` / event handlers are stripped").
 *
 * Sanitization runs server-side (no DOM), so it is a conservative deny-list over
 * the HTML `marked` produces:
 * - removes <script>, <style>, <iframe>, <object>, <embed> elements (and content)
 * - strips inline event-handler attributes (on*)
 * - neutralizes javascript:/vbscript:/data: URLs in href/src
 *
 * Untrusted *artifact* code is never rendered through this path — artifacts run
 * only inside the cross-origin sandbox (§28.1). This renderer is for documents.
 */

import { marked } from "marked";

/**
 * Paired dangerous elements (open tag through matching close tag, content
 * included). Literal regexes so the patterns are static (no dynamic RegExp).
 */
const PAIRED_DANGEROUS = [
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi,
  /<object\b[^>]*>[\s\S]*?<\/object\s*>/gi,
  /<embed\b[^>]*>[\s\S]*?<\/embed\s*>/gi,
];

/** Lone/void dangerous tags (no content), plus any stragglers of the above. */
const LONE_DANGEROUS =
  /<\/?(?:script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi;

/** Remove dangerous element blocks (open tag through matching close tag). */
function stripDangerousElements(html: string): string {
  let out = html;
  for (const pattern of PAIRED_DANGEROUS) {
    out = out.replace(pattern, "");
  }
  out = out.replace(LONE_DANGEROUS, "");
  return out;
}

/**
 * Strip inline event-handler attributes: on*="…" / on*='…' / on*=value.
 * The leading boundary is `[\s/]` (whitespace OR `/`) rather than just `\s`, so
 * an attribute packed against the previous one without a space — e.g.
 * `<img src='x'onerror='evil()'>` — is still caught. We also catch the case
 * where the handler follows a closing quote of the prior attribute by running
 * the pass to a fixed point (repeat until no further change), since a single
 * pass can leave adjacent handlers behind after the preceding attribute's quote.
 */
function stripEventHandlers(html: string): string {
  const pattern = /[\s/'"]on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
  let out = html;
  let prev: string;
  do {
    prev = out;
    // Keep the boundary char (it belongs to the prior token) and drop the handler.
    out = out.replace(pattern, (m) => m.charAt(0));
  } while (out !== prev);
  return out;
}

/**
 * Neutralize dangerous URL schemes (javascript:/vbscript:/data:) in href/src.
 * Handled in three forms so a `>` inside a quoted value cannot terminate the
 * match early (the prior single-regex `[^"'\s>]*` form failed on
 * `src="data:text/html,<h1>x</h1>"`):
 *  - double-quoted: capture through the matching `"`.
 *  - single-quoted: capture through the matching `'`.
 *  - unquoted: capture to whitespace or `>`.
 */
function neutralizeUrls(html: string): string {
  let out = html;
  out = out.replace(
    /\b(href|src)\s*=\s*"\s*(?:javascript|vbscript|data)\s*:[^"]*"/gi,
    '$1="#"'
  );
  out = out.replace(
    /\b(href|src)\s*=\s*'\s*(?:javascript|vbscript|data)\s*:[^']*'/gi,
    "$1='#'"
  );
  out = out.replace(
    /\b(href|src)\s*=\s*(?:javascript|vbscript|data)\s*:[^\s>]*/gi,
    "$1=#"
  );
  return out;
}

/** Sanitize a fragment of HTML for safe serving. Exported for unit tests. */
export function sanitizeHtml(html: string): string {
  let out = stripDangerousElements(html);
  out = stripEventHandlers(out);
  out = neutralizeUrls(out);
  return out;
}

/**
 * Render markdown to a sanitized HTML string. Synchronous and dependency-light;
 * uses `marked` (already a project dependency) for parsing.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const raw = marked.parse(markdown ?? "", { async: false }) as string;
  return sanitizeHtml(raw);
}
