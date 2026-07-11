/**
 * Atrium Meridian presence colors + helpers (Epic #1059 slice C)
 *
 * Pure, framework-free helpers shared by the editor presence layer. The Meridian
 * rule (README): violet is agent, ALWAYS and only. Humans get green / terracotta /
 * blue — and the CURRENT user always renders green to themselves ("you are green"),
 * while every OTHER human gets a stable terracotta/blue assignment from their id.
 *
 * These are perspective-relative: each client broadcasts its own "other-human"
 * color over Yjs awareness so peers render it consistently, and the local renderer
 * overrides the caller's OWN avatar to the green `human-you` token.
 */

/** Agent presence color (violet) — reserved exclusively for the AI agent. */
export const PRESENCE_AGENT = "#6d4fc2";
/** The current user's own color (green) — how you always see yourself. */
export const PRESENCE_YOU = "#3e7c4f";
/** Stable palette for OTHER humans (terracotta, blue), cycled by user id. */
export const PRESENCE_OTHERS = ["#b4552d", "#4a7ce8"] as const;

export type PresenceKind = "human" | "agent";

/** One entry in the presence roster (a connected awareness client). */
export interface PresenceUser {
  /** Yjs awareness client id (stable per connection). */
  clientId: number;
  /** Application user id (number for humans; used to detect "self"). */
  id: number | null;
  name: string;
  initials: string;
  kind: PresenceKind;
  /** The broadcast color (peers render this; self is overridden to green). */
  color: string;
}

/**
 * The stable "other human" color for a user id. Deterministic so the same person
 * keeps the same color across reconnects and across every peer's view.
 */
export function otherHumanColor(id: number | null): string {
  if (id == null) return PRESENCE_OTHERS[0];
  // A non-negative index; PRESENCE_OTHERS has length 2.
  const idx = Math.abs(Math.trunc(id)) % PRESENCE_OTHERS.length;
  return PRESENCE_OTHERS[idx];
}

/**
 * The color to RENDER a roster entry with from the local caller's perspective:
 * the caller's own avatar is green (`human-you`), the agent is violet, and every
 * other human keeps its broadcast color.
 */
export function renderColorFor(
  user: Pick<PresenceUser, "id" | "kind" | "color">,
  localUserId: number | null
): string {
  if (user.kind === "agent") return PRESENCE_AGENT;
  if (localUserId != null && user.id === localUserId) return PRESENCE_YOU;
  return user.color;
}

/** Two-letter uppercase initials from a display name or email. */
export function initialsFromName(name?: string | null, email?: string | null): string {
  const n = (name ?? "").trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase();
    }
    return n.slice(0, 2).toUpperCase();
  }
  const e = (email ?? "").trim();
  return e ? e.charAt(0).toUpperCase() : "?";
}
