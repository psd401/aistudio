"use client";

/**
 * Per-viewer provenance-rail preference (#1336 B7).
 *
 * The Atrium editor's authorship rail (green = human, purple = agent) is on by
 * default but can be toggled off from the editor topbar. The choice is a VIEW
 * preference, not document state: it is CSS-only gating — the `atriumAuthored`
 * marks and the rail decorations stay in the document untouched — so it is
 * stored per viewer in `localStorage` and never written to Yjs or the database.
 *
 * Implemented as a tiny external store read through `useSyncExternalStore`
 * rather than "default true, then correct it in an effect". The effect version
 * both trips `react-hooks/set-state-in-effect` and paints the rail for a frame
 * before hiding it; `useSyncExternalStore` gives React an explicit server
 * snapshot (always `true`) so hydration is clean and the stored value is applied
 * in the same commit.
 */

import { useCallback, useSyncExternalStore } from "react";

const PROVENANCE_PREF_KEY = "atrium.provenanceRail";

/** Subscribers for same-tab updates (the `storage` event only fires cross-tab). */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Cross-tab: another tab toggling the preference updates this one too.
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * In-memory fallback used when `localStorage` is unavailable (private mode,
 * storage disabled). Keeps the toggle working for the session even though the
 * choice cannot outlive it. `null` = no in-session choice made.
 */
let memoryFallback: boolean | null = null;

/** Client snapshot: shown unless explicitly stored as "off". */
function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(PROVENANCE_PREF_KEY) !== "off";
  } catch {
    return memoryFallback ?? true;
  }
}

/** Server snapshot: the rail defaults to SHOWN. */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * `[shown, toggle]` for the provenance rail. Defaults to shown; persists the
 * viewer's choice across sessions and tabs.
 */
export function useProvenancePref(): [boolean, () => void] {
  const on = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next = !on;
    try {
      window.localStorage.setItem(PROVENANCE_PREF_KEY, next ? "on" : "off");
    } catch {
      // Storage unavailable: keep the choice for this session only.
      memoryFallback = next;
    }
    emit();
  }, [on]);

  return [on, toggle];
}
