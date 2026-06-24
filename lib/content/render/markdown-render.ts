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
 * Sanitization runs server-side via DOMPurify on a jsdom window — an AST/DOM
 * allowlist sanitizer, not a regex deny-list. The HTML is parsed into a real DOM
 * before the allowlist runs, so entity-encoded scheme bypasses
 * (`java&#x73;cript:`), malformed/unclosed tags (`</script\t\n bar>`), and
 * attribute-injection vectors (`formaction`, SVG `xlink:href`, etc.) that defeat
 * regex deny-lists are resolved at parse time. The previous implementation used a
 * regex deny-list flagged by CodeQL (`js/bad-tag-filter`,
 * `js/incomplete-multi-character-sanitization`) and by multiple reviewers; this
 * DOM approach replaces it.
 *
 * Untrusted *artifact* code is never rendered through this path — artifacts run
 * only inside the cross-origin sandbox (§28.1). This renderer is for documents.
 */

import { marked } from "marked";
import createDOMPurify, { type DOMPurify } from "dompurify";
import { JSDOM } from "jsdom";

/**
 * URL schemes permitted in `href`/`src`. Anything else (notably `javascript:`,
 * `vbscript:`, and `data:`) is stripped. Absolute URLs, root-relative paths
 * (`/foo`), same-document `./` references, and same-page anchors are allowed.
 * DOMPurify decodes HTML entities before this hook runs, so an entity-encoded
 * scheme is already normalized to its literal form here.
 *
 * NOTE: parent-traversal (`../`) is intentionally NOT allowed. Phase 0 serves
 * render.html from S3 with Content-Disposition: attachment, so traversal is
 * inert today — but if Phase 1 renders snapshots inline (iframe /
 * dangerouslySetInnerHTML), a stored `[x](../../admin/reset)` link could walk
 * app routes. Disallowing it now keeps already-stored snapshots safe for that
 * future path. (See the Phase 1 render ticket: re-audit stored render.html.)
 */
const SAFE_URL_SCHEME = /^(?:https?:|mailto:|tel:|#|\/|\.\/)/i;

/** Plain URL-bearing attributes checked against the scheme allowlist. */
const URL_ATTRS = ["href", "src"] as const;

/** The XLink namespace SVG `xlink:href` lives in (set via setAttributeNS). */
const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * Lazily-constructed DOMPurify instance bound to a jsdom window. Built once per
 * process (jsdom window creation is non-trivial) and reused for every render.
 * Created lazily so importing this module does not pay the jsdom cost unless a
 * render actually happens.
 */
let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify {
  if (purifier) return purifier;
  const { window } = new JSDOM("");
  const instance = createDOMPurify(window as unknown as Window & typeof globalThis);

  // Defense-in-depth on top of DOMPurify's own protocol allowlist: strip any
  // URL-bearing attribute whose (entity-decoded) value is not an allowed scheme.
  // This also removes `data:` URIs, which DOMPurify permits by default on some
  // elements (e.g. <img src>).
  instance.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (typeof el.hasAttribute !== "function") return;
    for (const attr of URL_ATTRS) {
      if (el.hasAttribute(attr)) {
        const value = (el.getAttribute(attr) ?? "").trim();
        if (value && !SAFE_URL_SCHEME.test(value)) {
          el.removeAttribute(attr);
        }
      }
    }
    // SVG `xlink:href` lives in the XLink namespace; the unprefixed
    // has/get/removeAttribute calls above cannot see it. Use the *NS variants so
    // this defense-in-depth scheme check actually covers it.
    if (typeof el.getAttributeNS === "function") {
      const xlink = (el.getAttributeNS(XLINK_NS, "href") ?? "").trim();
      if (xlink && !SAFE_URL_SCHEME.test(xlink)) {
        el.removeAttributeNS(XLINK_NS, "href");
      }
    }
  });

  purifier = instance;
  return instance;
}

/**
 * Sanitize a fragment of HTML for safe serving. Parses into a DOM, applies the
 * allowlist, and serializes back to a string. Exported for unit tests.
 *
 * Forbidden tags (beyond DOMPurify's defaults) keep document HTML to inert,
 * presentational markup: no <base> (relative-URL hijacking — a single
 * `<base href="https://attacker.com/">` would re-root every relative link, image,
 * and stylesheet in the stored snapshot against an attacker origin), no <style>
 * (CSS exfiltration / layout attacks), no embedding tags
 * (<iframe>/<object>/<embed>), no form controls. <script> and all `on*` event
 * handlers are stripped by DOMPurify's defaults.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  return getPurifier().sanitize(html, {
    FORBID_TAGS: ["base", "style", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["style"],
  });
}

/**
 * Render markdown to a sanitized HTML string. Synchronous; uses `marked`
 * (already a project dependency) for parsing, then the DOM sanitizer above.
 * `marked` is configured for synchronous output; the result is asserted to be a
 * string so a future async-mode regression fails loudly rather than silently
 * serializing a Promise.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const raw = marked.parse(markdown ?? "", { async: false });
  if (typeof raw !== "string") {
    throw new TypeError(
      "marked.parse returned a non-string; expected sync output"
    );
  }
  return sanitizeHtml(raw);
}
