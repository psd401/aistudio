/**
 * Atrium embedded-artifact directive (Epic #1059 Meridian redesign, slice D)
 *
 * The canonical persistence format for an artifact embedded inside a document.
 * An embed is a single markdown LEAF DIRECTIVE on its own line:
 *
 *     ::atrium-artifact{id="<artifact-object-uuid>"}
 *
 * This ONE format is the contract every pipeline that must agree on how an embed
 * round-trips shares (Meridian slice-D handoff):
 *  - editor  → markdown : the TipTap node serializes to this exact line
 *    (`artifact-embed-node.ts` addStorage.markdown.serialize).
 *  - markdown → editor  : the seeding/agent path (`markdown-bridge.ts`) rewrites
 *    this line to the embed node's DOM before ProseMirror parses it.
 *  - markdown → reader  : `renderDocumentToParts` splits the document on these
 *    lines and renders each embed as a live, visibility-gated sandbox.
 *  - snapshot → backlinks: `snapshotInTx` parses the ids out of a document body
 *    to maintain the `content_embed_links` backlink table.
 *
 * Kept dependency-free (a pure regex — no unified/marked/tiptap import) so it can
 * be imported by the version-service write primitive and the collab-server bundle
 * without dragging a heavy parser into either.
 */

/** The leaf-directive name (remark-directive `::<name>{...}`). */
export const ARTIFACT_EMBED_DIRECTIVE_NAME = "atrium-artifact";

/** The DOM data attribute the TipTap node renders / parses. */
export const ARTIFACT_EMBED_DATA_ATTR = "data-atrium-artifact-embed";
export const ARTIFACT_EMBED_ID_ATTR = "data-artifact-id";

/**
 * UUID v4-ish shape — the form a `content_objects.id` takes (defaultRandom()).
 * Validated everywhere an id crosses a boundary so a malformed / injected value
 * never becomes a DB lookup key or a rendered attribute.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A whole-line match for an embed directive (the directive is always block-level,
 * on its own line). Capture group 1 is the raw attribute payload between braces.
 */
export const ARTIFACT_EMBED_LINE_RE =
  /^[ \t]*::atrium-artifact\{([^}]*)\}[ \t]*$/;

/** Whether a string is a valid content-object id (UUID shape). */
export function isArtifactId(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Extract a validated artifact id from a directive's attribute payload, or null.
 * Accepts the quoted form we emit (`id="<uuid>"`) and the bare/`#`-shorthand
 * forms for resilience; the UUID validation is the security gate.
 */
export function parseArtifactEmbedAttrs(attrs: string): string | null {
  const m = attrs.match(/(?:\bid\s*=\s*"?|#)([0-9a-fA-F-]+)"?/);
  const id = m?.[1];
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * Serialize an embed to its canonical directive line. Returns null for an id that
 * is not a valid UUID, so a corrupt node never writes a malformed directive that
 * could later re-parse into a lookup on attacker-controlled text.
 */
export function serializeArtifactEmbedDirective(id: string): string | null {
  return UUID_RE.test(id)
    ? `::atrium-artifact{id="${id.toLowerCase()}"}`
    : null;
}

/**
 * A fenced-code delimiter on its own line: a run of ≥3 backticks or ≥3 tildes
 * (after up to some leading whitespace). Returns the delimiter char + run length
 * and whether any non-whitespace TRAILS the run, or null when the line is not a
 * fence. CommonMark distinguishes the open fence (may carry an info string, so
 * trailing text is allowed) from the CLOSE fence (delimiters only, trailing must
 * be whitespace) — the caller uses `hasTrailing` to enforce that.
 */
function matchFence(
  line: string
): { char: string; len: number; hasTrailing: boolean } | null {
  const m = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length, hasTrailing: m[2].trim().length > 0 };
}

/**
 * The ONE definition of "which lines of a raw markdown body are real block-level
 * artifact-embed directives", shared by the reader split (`renderDocumentToParts`)
 * and the snapshot backlink parser (`parseEmbeddedArtifactIds`) so the two can
 * never disagree (a directive that is a live embed for one but inert text for the
 * other would desync the rendered doc from its `content_embed_links` backlinks).
 *
 * Fenced-code tracking mirrors CommonMark, NOT a naive toggle:
 *  - a fence OPENS on a ```/~~~ line (an info string after the run is allowed);
 *  - it CLOSES only on a later line using the SAME fence character with a run
 *    length ≥ the opener's AND no trailing text (delimiters + whitespace only);
 *  - an unmatched fence stays OPEN to end-of-input — so one mismatched ~~~ inside
 *    an unclosed ``` block cannot resurrect a live embed for everything after it.
 *
 * `onLine(line, embedId)` is invoked for EVERY line in order; `embedId` is the
 * validated artifact id when the line is a real block-level embed directive
 * (its own whole line, outside any fence), else null (ordinary text — including a
 * malformed directive or one documented inside a code fence).
 */
export function scanMarkdownEmbedLines(
  markdown: string,
  onLine: (line: string, embedId: string | null) => void
): void {
  let openChar = "";
  let openLen = 0;
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = matchFence(line);
    if (inFence) {
      // Close only on the SAME delimiter char, run length ≥ opener, delimiters only.
      if (fence && fence.char === openChar && fence.len >= openLen && !fence.hasTrailing) {
        inFence = false;
        openChar = "";
        openLen = 0;
      }
      onLine(line, null);
      continue;
    }
    if (fence) {
      inFence = true;
      openChar = fence.char;
      openLen = fence.len;
      onLine(line, null);
      continue;
    }
    const m = line.match(ARTIFACT_EMBED_LINE_RE);
    onLine(line, m ? parseArtifactEmbedAttrs(m[1]) : null);
  }
}

/**
 * Parse every embedded artifact id out of a document markdown body (deduped, in
 * first-seen order). Used by the snapshot write primitive to maintain the
 * `content_embed_links` backlink table. Pure + cheap (fence-aware line scan).
 *
 * Fence-aware via the shared `scanMarkdownEmbedLines`: a directive that merely
 * DOCUMENTS the syntax inside a ```/~~~ code block is NOT a real embed and never
 * creates a backlink row.
 */
export function parseEmbeddedArtifactIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  scanMarkdownEmbedLines(markdown, (_line, embedId) => {
    if (embedId && !seen.has(embedId)) {
      seen.add(embedId);
      ids.push(embedId);
    }
  });
  return ids;
}
