/**
 * Persisted width of the Nexus workspace panel (#1793).
 *
 * The panel used to be a fixed `44%` split capped at 720px. With the Nexus
 * sidebar open on a ~1255px window that lands around 350px — phone width — so a
 * dashboard an author was building collapsed to one column and grew a
 * horizontal scrollbar INSIDE the panel, and the desktop layout they were
 * actually authoring was never visible while iterating.
 *
 * The split is now drag-resizable and the chosen width persists, as a FRACTION
 * of the split container rather than a pixel count: the container width changes
 * with the window and with the Nexus sidebar opening/collapsing, and a stored
 * pixel width would mean a different split every time.
 *
 * Storage is `localStorage` (per browser profile, i.e. per user on their own
 * machine) — a layout preference is not worth a round trip to the database, and
 * it must be readable synchronously on the first paint so the panel does not
 * visibly jump from the default to the stored width.
 */

/** localStorage key holding the fraction (0–1) of the split taken by the panel. */
export const WORKSPACE_PANEL_WIDTH_KEY = "nexus.workspacePanelWidthPct";

/**
 * Half the content area — the #1793 ask ("default the panel to at least half").
 * A 4-KPI + chart dashboard renders in its real desktop layout at this width on
 * a normal laptop window.
 */
export const DEFAULT_WORKSPACE_PANEL_WIDTH_PCT = 0.5;

/** Below this the panel is back to the phone-width rendering #1793 is about. */
export const MIN_WORKSPACE_PANEL_PX = 380;

/** The chat must stay usable as a column, not become a sliver. */
export const MIN_CHAT_COLUMN_PX = 320;

/**
 * Clamp a requested fraction so BOTH columns keep their minimum, given the
 * measured split width. When the container is too narrow to satisfy both
 * minimums at once (below ~700px) the panel minimum wins — the chat still
 * scrolls, whereas a sub-380px panel is the bug being fixed. The panel itself
 * only renders at `md` and up, so this is not the phone path.
 */
export function clampWorkspacePanelWidthPct(
  pct: number,
  containerWidthPx: number
): number {
  if (!Number.isFinite(pct)) return DEFAULT_WORKSPACE_PANEL_WIDTH_PCT;
  if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return Math.min(Math.max(pct, 0), 1);
  }
  const minPct = MIN_WORKSPACE_PANEL_PX / containerWidthPx;
  const maxPct = (containerWidthPx - MIN_CHAT_COLUMN_PX) / containerWidthPx;
  // Panel minimum wins a conflict (see doc comment above).
  if (maxPct < minPct) return Math.min(minPct, 1);
  return Math.min(Math.max(pct, minPct), maxPct);
}

/**
 * The stored fraction, or the default. Never throws: `localStorage` access is a
 * SecurityError in some embedded/private contexts, and a corrupt value (any
 * origin-local script can write one) must not take the panel down.
 */
export function readStoredWorkspacePanelWidthPct(): number {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_PANEL_WIDTH_PCT;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY);
  } catch {
    return DEFAULT_WORKSPACE_PANEL_WIDTH_PCT;
  }
  if (raw === null) return DEFAULT_WORKSPACE_PANEL_WIDTH_PCT;
  const parsed = Number.parseFloat(raw);
  // Reject anything outside a sane split, including NaN.
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return DEFAULT_WORKSPACE_PANEL_WIDTH_PCT;
  }
  return parsed;
}

/** Persist the fraction, ignoring storage failures (quota, private mode). */
export function storeWorkspacePanelWidthPct(pct: number): void {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 1) return;
  try {
    window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, pct.toFixed(4));
  } catch {
    // A layout preference is not worth surfacing a storage error for.
  }
}
