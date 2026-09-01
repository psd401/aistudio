"use client";

/**
 * Per-viewer expanded-sections state for the Atrium CollectionTree.
 *
 * The section tree used to start FULLY EXPANDED on every visit: each row held a
 * `useState(true)`, so the whole tree unfolded again on every navigation and
 * reload, and nothing the viewer collapsed survived a single route change. The
 * tree now starts COLLAPSED and remembers exactly which sections the viewer
 * opened, per user, across sessions and tabs.
 *
 * Same shape as `use-provenance-pref.ts`: a tiny external store read through
 * `useSyncExternalStore` rather than "default, then correct it in an effect".
 * React gets an explicit server snapshot (nothing expanded) so hydration is
 * clean and the stored expansions apply in the same commit — no frame where the
 * tree paints one way and then snaps to another.
 *
 * Storage is a JSON array of collection ids under a per-viewer key. Ids of
 * sections that no longer exist (deleted, no longer visible) are simply never
 * matched by a row and are harmless; they are not pruned.
 */

import { useCallback, useSyncExternalStore } from "react";

/**
 * Storage key, scoped PER VIEWER. On a shared or kiosk machine a global key
 * would carry one user's layout into the next user's session on the same
 * browser — nothing sensitive, but the wrong scope. Before the user record has
 * loaded (`userId === null`) the state is held in memory only and never
 * written to storage, so the pre-load window cannot leak into any key.
 */
function expandedSectionsKey(userId: number): string {
  return `atrium.expandedSections:${userId}`;
}

/** Subscribers for same-tab updates (the `storage` event only fires cross-tab). */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Cross-tab: another tab expanding a section updates this one too.
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * In-memory fallback used when `localStorage` is unavailable (private mode,
 * storage disabled) and for the not-yet-identified viewer. Keyed like storage.
 */
const memoryFallback = new Map<string, string>();

/** The key used while the viewer is unknown; never written to localStorage. */
const ANON_KEY = "atrium.expandedSections:anon";

function readRaw(key: string): string | null {
  if (key === ANON_KEY) return memoryFallback.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function writeRaw(key: string, raw: string): void {
  if (key === ANON_KEY) {
    memoryFallback.set(key, raw);
    return;
  }
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    // Storage unavailable: keep the layout for this session only.
    memoryFallback.set(key, raw);
  }
}

function parse(raw: string | null): ReadonlySet<string> {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * `useSyncExternalStore` compares snapshots by reference, so a Set must be the
 * SAME object for as long as the stored value is unchanged — parsing a fresh
 * Set on every read would re-render forever. Cache the parsed Set against the
 * raw string it came from, per key.
 */
const parsedCache = new Map<string, { raw: string | null; set: ReadonlySet<string> }>();

function snapshotFor(key: string): ReadonlySet<string> {
  const raw = readRaw(key);
  const cached = parsedCache.get(key);
  if (cached && cached.raw === raw) return cached.set;
  const set = parse(raw);
  parsedCache.set(key, { raw, set });
  return set;
}

/** Server snapshot: nothing expanded — the tree starts collapsed. */
function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY;
}

/**
 * `[expandedIds, toggle]` for the section tree. Starts collapsed; persists the
 * viewer's expansions across sessions and tabs, scoped to `userId`. Pass `null`
 * until the viewer is known (memory-only until then).
 */
export function useExpandedSections(
  userId: number | null
): [ReadonlySet<string>, (collectionId: string) => void] {
  const key = userId === null ? ANON_KEY : expandedSectionsKey(userId);

  // Recreated when the key changes, which is what re-reads the new viewer's
  // stored layout. Safe for `useSyncExternalStore` despite the unstable
  // identity: the returned Set is reference-stable via `parsedCache`.
  const getSnapshot = useCallback((): ReadonlySet<string> => snapshotFor(key), [key]);

  const expanded = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(
    (collectionId: string) => {
      const next = new Set(snapshotFor(key));
      if (next.has(collectionId)) next.delete(collectionId);
      else next.add(collectionId);
      writeRaw(key, JSON.stringify([...next]));
      emit();
    },
    [key]
  );

  return [expanded, toggle];
}
