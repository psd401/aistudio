/**
 * Atrium HTML sanitizer (DOM allowlist)
 *
 * Issue #1058/#1051 (Epic #1059, Atrium). A standalone DOM-allowlist sanitizer
 * for raw HTML strings, built on DOMPurify over a jsdom window. Split out of
 * `markdown-render.ts` so it stays free of the pure-ESM unified/remark/rehype
 * imports — `next/jest` (SWC) cannot transform those node_modules, so the
 * markdown render pipeline is not jest-loadable, but this sanitizer (and its
 * security tests) must be.
 *
 * This is NOT the markdown render path: `renderMarkdownToHtml` sanitizes inside
 * its unified chain (rehype-sanitize) and must keep KaTeX's inline styles, which
 * this function (correctly) forbids. Use this only when sanitizing a raw HTML
 * string directly.
 *
 * Sanitization runs as an AST/DOM allowlist (not a regex deny-list): HTML is
 * parsed into a real DOM before the allowlist runs, so entity-encoded scheme
 * bypasses (`java&#x73;cript:`), malformed/unclosed tags, and attribute-injection
 * vectors (`formaction`, SVG `xlink:href`) are resolved at parse time.
 */

import createDOMPurify, { type DOMPurify } from "dompurify";
import { JSDOM } from "jsdom";

/**
 * URL schemes permitted in `href`/`src`. Anything else (notably `javascript:`,
 * `vbscript:`, and `data:`) is stripped. Absolute URLs, root-relative paths
 * (`/foo`), same-document `./` references, and same-page anchors are allowed.
 * DOMPurify decodes HTML entities before this hook runs, so an entity-encoded
 * scheme is already normalized to its literal form here.
 *
 * NOTE: parent-traversal (`../`) is intentionally NOT allowed.
 */
const SAFE_URL_SCHEME = /^(?:https?:|mailto:|tel:|#|\/|\.\/)/i;

/** Plain URL-bearing attributes checked against the scheme allowlist. */
const URL_ATTRS = ["href", "src"] as const;

/** The XLink namespace SVG `xlink:href` lives in (set via setAttributeNS). */
const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * Lazily-constructed DOMPurify instance bound to a jsdom window. Built once per
 * process and reused. Created lazily so importing this module does not pay the
 * jsdom cost unless a render actually happens.
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
 * allowlist, and serializes back to a string.
 *
 * Forbidden tags (beyond DOMPurify's defaults) keep document HTML to inert,
 * presentational markup: no <base> (relative-URL hijacking), no <style> (CSS
 * exfiltration / layout attacks), no embedding tags (<iframe>/<object>/<embed>),
 * no form controls. <script> and all `on*` event handlers are stripped by
 * DOMPurify's defaults.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  return getPurifier().sanitize(html, {
    FORBID_TAGS: ["base", "style", "iframe", "object", "embed", "form", "input", "button"],
    // `ping` is a valid <a> attribute in DOMPurify v3 defaults: it silently POSTs
    // to the listed URL(s) on click (a tracking/exfil vector). Rendered document
    // HTML never needs it, so forbid it outright. `style` is forbidden to block
    // CSS-based layout/exfiltration attacks.
    FORBID_ATTR: ["style", "ping"],
  });
}
