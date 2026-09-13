/**
 * The "a chat tool just changed the open workspace object" signal (#1749).
 *
 * A `window` CustomEvent, deliberately NOT a React context or a conversation-
 * runtime subscription: `WorkspacePanel` and `ArtifactCanvas` are pure layout
 * siblings of the Nexus conversation tree and must stay completely unaware of it
 * (see the header comments on both components and
 * `docs/features/nexus-conversation-architecture.md`). A DOM event lets the tool
 * surface tell them "refetch" without either side importing the other.
 *
 * Emitted by the Nexus tool-call renderer when a workspace-mutating tool result
 * lands; consumed by `WorkspacePanel` ALONE, which re-runs
 * `loadWorkspacePanelAction` (where the pinned `dataAccess` comes from) and then
 * bumps `ArtifactCanvas`'s `refreshSignal` prop. The canvas deliberately does NOT
 * subscribe here: two independent listeners meant two independently-timed,
 * independently-fallible fetches, and a panel fetch that failed while the canvas
 * one succeeded left the new code pinned to the OLD mode for the rest of the
 * session. One owner, one order. Without the signal at all, the chat writes a new
 * version, flips the mode, says "done", and the panel keeps rendering the OLD
 * version under the OLD pinned mode until the user reloads the page.
 */

/** The `window` event name. Namespaced so it cannot collide with app events. */
export const WORKSPACE_CHANGED_EVENT = "atrium:workspace-changed";

export interface WorkspaceChangedDetail {
  /**
   * The changed object's id, when the tool result carried one. `undefined` means
   * "unknown" — listeners then refresh unconditionally, because the workspace
   * tools are bound server-side to exactly the object the panel has open.
   */
  objectId?: string;
}

/** Fire the signal. No-op outside the browser (SSR / tests without a DOM). */
export function emitWorkspaceChanged(detail: WorkspaceChangedDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceChangedDetail>(WORKSPACE_CHANGED_EVENT, { detail })
  );
}

/**
 * Subscribe to the signal, returning an unsubscribe function for a `useEffect`
 * cleanup. `handler` receives the detail (possibly empty).
 */
export function onWorkspaceChanged(
  handler: (detail: WorkspaceChangedDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    handler((event as CustomEvent<WorkspaceChangedDetail>).detail ?? {});
  };
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
}

/**
 * True when `detail` concerns the object this listener is rendering.
 *
 * Two distinct "unknown"s, deliberately NOT treated the same:
 *  - the EVENT names no object (`detail.objectId` absent) → match, because the
 *    tool that fired it is bound server-side to whatever the panel has open.
 *  - the LISTENER has not resolved its own object yet (`objectId` null, the
 *    first load still in flight) → do NOT match. Its mount load is already
 *    fetching current server state, so refreshing on an event it cannot
 *    attribute is duplicate work racing that load — and every workspace-mutating
 *    tool result carries an `objectId` (#1749).
 */
export function workspaceChangeMatches(
  detail: WorkspaceChangedDetail,
  objectId: string | null | undefined
): boolean {
  if (!detail.objectId) return true;
  return detail.objectId === objectId;
}
