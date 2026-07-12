/**
 * Atrium rich-block directives — callout / image-grid / video (Meridian slice F)
 *
 * The canonical persistence format for the slice-F rich blocks, the sibling of
 * `embed-directive.ts` (slice D). Each block is a remark/CommonMark directive so it
 * round-trips through the ONE markdown body the whole loop shares:
 *
 *   callout (container) : `:::callout` … `:::`   /  `:::warn` … `:::`
 *   image grid (container): `:::grid` … `:::`  (children are plain `![alt](url)`)
 *   video (leaf)        : `::video{src="<http(s)-url>"}`
 *   image (inline/leaf) : standard markdown `![alt](url)` (no custom directive)
 *
 * This ONE module defines, for every pipeline that must agree:
 *  - the DOM class/tag each block renders to (the TipTap node `parseHTML`, the
 *    seeding `marked` extension, and the reader remark transform all use these), and
 *  - the media-URL safety gate (`isSafeMediaUrl`) + the video directive
 *    serialize/parse, so a video src can never carry a `javascript:`/`data:` URL
 *    into a rendered attribute.
 *
 * Kept dependency-free (pure string/regex + the WHATWG `URL` parser) so it is safe
 * to import from the collab-server bundle and the version-service write primitive
 * without dragging a markdown parser into either (mirrors `embed-directive.ts`).
 */

/** ProseMirror node names (shared client + server schema). */
export const CALLOUT_NODE_NAME = "atriumCallout";
export const IMAGE_NODE_NAME = "atriumImage";
export const IMAGE_GRID_NODE_NAME = "atriumImageGrid";
export const VIDEO_NODE_NAME = "atriumVideo";

/** DOM classes the reader render + editor NodeView + seeding all agree on. */
export const CALLOUT_CLASS = "atrium-callout";
export const CALLOUT_WARN_CLASS = "atrium-callout-warn";
export const IMAGE_GRID_CLASS = "atrium-image-grid";
export const VIDEO_CLASS = "atrium-video";

/** The remark/CommonMark directive names (container `:::name`, leaf `::name`). */
export const CALLOUT_DIRECTIVE = "callout";
export const CALLOUT_WARN_DIRECTIVE = "warn";
export const IMAGE_GRID_DIRECTIVE = "grid";
export const VIDEO_DIRECTIVE = "video";

/** Callout variants (the toolbar offers both; reader tints them differently). */
export type CalloutVariant = "note" | "warn";

/**
 * Whether a URL is a safe media source: an absolute http/https URL only. This is
 * the SAME allowlist the reader's rehype-sanitize pins `src` to
 * (`markdown-render.ts` `protocols.src`), enforced here at the editor/seeding
 * boundary too so a bad URL never even serializes into a directive. Rejects
 * `javascript:`, `data:`, `blob:`, and relative/opaque forms.
 */
export function isSafeMediaUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Serialize a video block to its canonical leaf directive, or null for an unsafe /
 * missing src (so a corrupt node never writes a directive that could re-parse into
 * a rendered attribute carrying an unsafe URL). The src is quoted; a `"` in a URL
 * is not valid (it would break the attribute) and `isSafeMediaUrl` + `URL` parsing
 * reject it upstream, but strip any stray quote defensively.
 */
export function serializeVideoDirective(src: string): string | null {
  if (!isSafeMediaUrl(src)) return null;
  const safe = src.replace(/"/g, "");
  return `::video{src="${safe}"}`;
}

/**
 * Extract a validated (safe) video src from a directive's attribute payload, or
 * null. Accepts the quoted form we emit (`src="<url>"`); the URL safety check is
 * the security gate.
 */
export function parseVideoDirectiveAttrs(attrs: string): string | null {
  const m = attrs.match(/\bsrc\s*=\s*"([^"]*)"/);
  const src = m?.[1];
  return src && isSafeMediaUrl(src) ? src : null;
}

/** A whole-line match for the `::video{…}` leaf directive (block-level, own line). */
export const VIDEO_LINE_RE = /^[ \t]*::video\{([^}]*)\}[ \t]*$/;
