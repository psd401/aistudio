/**
 * What the object open in the workspace panel (`?workspace=<id|slug>`) means for
 * a Nexus turn's tools — the ONE definition of that rule (#1786).
 *
 * Why this exists: the model router attached the PSD Data connector per
 * MESSAGE, only when that one message classified as `psd-data`. While a live
 * dashboard was open beside the chat, a normal follow-up ("add a school
 * dropdown", "the chart is empty, fix it") classified as `general`, so the turn
 * lost `list_available_tables` / `inspect_table_schema` / `query_data` — and the
 * model then wrote SQL against GUESSED column names, reported success, and
 * silently broke a working dashboard. The open artifact is the missing routing
 * input: editing an artifact is data work regardless of how the sentence reads.
 *
 * DELIBERATELY DEPENDENCY-FREE (types only). Three surfaces must agree on this
 * rule or the UI will contradict the server:
 *   - `lib/nexus/model-router/router.ts` — attaches the connector for the turn;
 *   - `app/api/nexus/chat/route.ts` — adds the do-not-guess guidance when it
 *     could not be attached;
 *   - `actions/mcp-connector.actions.ts` — tells the composer's Connect popover
 *     that PSD Data is on for this workspace, so the toggle stops reading "off"
 *     while the model is using it.
 * Keeping this module free of the content service also keeps routing from
 * importing it just to read three fields.
 */

export interface NexusWorkspaceRoutingContext {
  /** Resolved content object id (never the caller's raw slug). */
  objectId: string;
  kind: "document" | "artifact";
  /** Whether the SESSION user may edit it — a read-only viewer cannot author. */
  editable: boolean;
}

/**
 * True when a turn taken against the open workspace object needs the PSD Data
 * tools attached regardless of how the user's sentence classifies.
 *
 * Editable ARTIFACTS, unconditionally — not only `dataAccess === "query"`. An
 * artifact in `records` mode is one `update_workspace_artifact` call away from
 * `query` mode (that tool sets the mode in the same call that writes the code),
 * and "make this chart use real data" is exactly the turn that flips it, so
 * gating on the CURRENT mode would leave the first live-data turn blind.
 * Documents have no sandbox and no data bridge, and a read-only viewer authors
 * nothing, so neither gets the connector and neither pays for the lookup.
 */
export function workspaceNeedsPsdData(
  workspace: NexusWorkspaceRoutingContext | null | undefined
): boolean {
  return workspace?.kind === "artifact" && workspace.editable;
}

/**
 * Appended to the workspace system-prompt fragment when an editable artifact is
 * open but the PSD Data tools could NOT be attached this turn — the connector is
 * unconfigured, unavailable, or the router is in shadow mode.
 *
 * Model-facing text, not user copy. Without it the model reads
 * `ATRIUM_DATA_AUTHORING_GUIDANCE` ("Explore the data with a couple of
 * queries"), finds no query tool, and invents column names anyway.
 */
export const WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE =
  " PSD DATA TOOLS ARE NOT AVAILABLE ON THIS TURN: you have no way to list tables," +
  " inspect a schema, or run a query. Do NOT guess table or column names and do NOT" +
  " write or edit SQL you cannot verify. Keep any SQL already in the artifact exactly" +
  " as it is, make only the changes you can make without knowing the schema, and tell" +
  " the user plainly that you could not verify the data schema and that they should" +
  " switch PSD Data on in the Connect menu for data changes.";
