/**
 * One provenance label for a content version, shared by every surface that
 * shows one (#1791 finding 6).
 *
 * The Nexus workspace chat tools deliberately run under the USER's own
 * requester: the model can never exceed what the person may do, and the version
 * is therefore `authorActor: "human"` — correctly, because that requester is
 * what the write was authorized against. The cost was that a version the chat
 * MODEL wrote was indistinguishable from one the person typed in the Code tab:
 * the dropdown read "v3 · human" and the About rail said "Human-authored", so
 * "who wrote this SQL?" had no answer anywhere in the product.
 *
 * `authorLabel` (migration 183) records the authoring SURFACE alongside the
 * unchanged authorization record. This module turns the pair into the one
 * phrase the UI shows, so the version dropdown, the History dialog and the
 * About rail can never drift apart.
 *
 * Deliberately never "you": `VersionSummary` omits `authorUserId` on purpose
 * (anti-enumeration — a raw internal user id must not reach every viewer), so
 * no surface can tell whether the human author is the current viewer. "via
 * Nexus chat" is accurate for every viewer; "you, via Nexus chat" would
 * mislabel an admin's edit as the viewer's own.
 */

/** The surface label the Nexus workspace chat stamps on versions it writes. */
export const NEXUS_CHAT_AUTHOR_LABEL = "nexus-chat";

/** The provenance fields any surface needs to label a version. */
export interface VersionAuthorship {
  authorActor: "human" | "agent";
  /** Authoring surface, or null/undefined for a directly-authored version. */
  authorLabel?: string | null;
}

/**
 * Short label for a version list ("AI", "via Nexus chat", "human").
 *
 * An autonomous agent's version stays "AI" regardless of any surface label:
 * `authorActor: "agent"` is the stronger statement and must not be softened.
 */
export function versionAuthorLabel(version: VersionAuthorship): string {
  if (version.authorActor === "agent") return "AI";
  if (version.authorLabel === NEXUS_CHAT_AUTHOR_LABEL) return "via Nexus chat";
  return "human";
}

/**
 * Sentence-form label for the About rail. Viewer-neutral on purpose: the DTO
 * omits `authorUserId`, so it cannot say WHOSE session the chat ran under — an
 * admin or co-editor reading this must not be told they wrote it.
 */
export function versionAuthorDescription(version: VersionAuthorship): string {
  if (version.authorActor === "agent") return "Agent-maintained · auto-refreshes";
  if (version.authorLabel === NEXUS_CHAT_AUTHOR_LABEL) {
    return "Written by the agent in Nexus chat";
  }
  return "Human-authored";
}
