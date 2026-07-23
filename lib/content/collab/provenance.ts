/**
 * Atrium provenance model (pure logic)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The authorship attribution carried by
 * the editor's `atriumAuthored` mark and rendered as the green/purple rail. Kept
 * free of TipTap/Yjs/ProseMirror imports so it is unit-testable under jest and
 * importable from both client and server.
 *
 * An author tag is an opaque string with a kind prefix:
 *   "human:<userId>"  -> green   (a logged-in human typed it)
 *   "ai:<agentId>"    -> purple   (an agent authored it)
 *   "agent:<id>"      -> purple   (alias accepted on input)
 * Anything else is "unknown" and contributes to neither tally.
 *
 * This mirrors Proof's `proofAuthored { by }` convention so the rebuilt editor
 * reads the same way: the `by` string is the single source of truth for who
 * authored a span, and the rail votes per block by character overlap.
 */

/** The Yjs XML fragment name shared by the client editor, server transformer,
 * and the agent bridge. Must match TipTap Collaboration's default `field`. */
export const COLLAB_FIELD = "default";

/** The TipTap mark name carrying authorship. */
export const AUTHORED_MARK = "atriumAuthored";

export type AuthorKind = "human" | "agent" | "unknown";

/** The visible authorship of a block: green, purple, or unattributed. */
export type BlockAuthor = "human" | "agent" | null;

/**
 * Classify an author tag. `ai:` and `agent:` both mean agent (purple); `human:`
 * means human (green). Unrecognized/empty tags are "unknown" and are ignored by
 * the rail rather than mislabeled.
 */
export function authorKindOf(by: string | null | undefined): AuthorKind {
  if (!by) return "unknown";
  if (by.startsWith("human:")) return "human";
  if (by.startsWith("ai:") || by.startsWith("agent:")) return "agent";
  return "unknown";
}

/**
 * Build a normalized author tag. Agents are normalized to the `ai:` prefix
 * (matching the rail/classifier); humans to `human:`. The id is coerced to a
 * string so numeric `users.id` and uuid agent ids both work.
 */
export function makeAuthorTag(actor: "human" | "agent", id: string | number): string {
  const safeId = String(id ?? "unknown").trim() || "unknown";
  return actor === "agent" ? `ai:${safeId}` : `human:${safeId}`;
}

/**
 * Decide a block's dominant author from its per-kind character tallies. The
 * author with more characters wins; an exact tie resolves to "human" (a human
 * touching an agent block should read as human-reviewed). A block with no
 * attributed characters is unlabeled (`null`) so the rail shows nothing rather
 * than guessing.
 */
export function dominantBlockAuthor(humanChars: number, agentChars: number): BlockAuthor {
  if (humanChars <= 0 && agentChars <= 0) return null;
  return humanChars >= agentChars ? "human" : "agent";
}
