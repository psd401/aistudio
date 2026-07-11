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
 * Parse every embedded artifact id out of a document markdown body (deduped, in
 * first-seen order). Used by the snapshot write primitive to maintain the
 * `content_embed_links` backlink table. Pure + cheap (line scan + regex).
 */
export function parseEmbeddedArtifactIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(ARTIFACT_EMBED_LINE_RE);
    if (!m) continue;
    const id = parseArtifactEmbedAttrs(m[1]);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
