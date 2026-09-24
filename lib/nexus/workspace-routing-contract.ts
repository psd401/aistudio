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

import type { McpConnectorToolsResult } from "@/lib/mcp/connector-types";

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
 * The PSD Data tools that can reveal a table's COLUMNS, and so are the only ones
 * that let a turn stop guessing.
 *
 * `list_available_tables` is deliberately absent. Knowing a table exists does not
 * tell you it has `location_code` rather than `school_name` — which is the exact
 * substitution that broke the dashboard in #1786 — so a turn holding only that
 * tool is still a guessing turn and must still get the warning.
 */
const WORKSPACE_PSD_DATA_SCHEMA_TOOLS = ["inspect_table_schema", "query_data"];

/**
 * True when this turn can author a data-backed artifact but ended up with no way
 * to verify a schema — the trigger for the do-not-guess guidance below.
 *
 * Asked of the connector results that will ACTUALLY reach the model, never of
 * the router's intent. The router choosing a connector is not the same as its
 * tools binding: the caller's connector access, a failed MCP handshake and a
 * skill's `allowed-tools` pin all bite after routing.
 *
 * And not merely "did the connector bind ANY tool". A skill pin can keep one
 * unrelated tool off this connector while dropping every data tool; counting
 * that as usable would suppress the warning for a model that cannot read a
 * schema at all, rebuilding the exact failure this module exists to prevent.
 * The question is whether a COLUMN-revealing tool survived.
 *
 * Fails toward warning on purpose: a connector that renamed these tools reads as
 * unavailable, which costs a redundant caution. The opposite error costs a
 * silently corrupted dashboard that reports success.
 *
 * @param connectorId the connector the router meant to carry the data tools, or
 *   null when it could not resolve one at all.
 * @param modelCanCallTools whether the SELECTED model can invoke tools at all.
 *   Model selection runs before this connector is attached and does not know a
 *   workspace turn wants data tools, so a model without function calling can be
 *   chosen and the connector still bind `query_data` beside it. Those tools are
 *   then unreachable, and treating them as present would suppress the warning on
 *   precisely the turn that cannot verify anything.
 */
export function workspacePsdDataToolsMissing(params: {
  workspace: NexusWorkspaceRoutingContext | null | undefined;
  connectorId: string | null;
  connectorToolResults: McpConnectorToolsResult[];
  modelCanCallTools: boolean;
}): boolean {
  if (!workspaceNeedsPsdData(params.workspace)) return false;
  if (!params.modelCanCallTools) return true;
  if (!params.connectorId) return true;
  return !params.connectorToolResults.some(
    (result) =>
      result.serverId === params.connectorId &&
      // `hasOwn`, not `in`: the tool set is keyed by names the connector
      // supplies, and `in` would also answer true for `constructor`/`toString`.
      WORKSPACE_PSD_DATA_SCHEMA_TOOLS.some((tool) =>
        Object.hasOwn(result.tools, tool)
      )
  );
}

/**
 * Appended to the workspace system-prompt fragment when an editable artifact is
 * open but the PSD Data tools could NOT be attached this turn — the connector is
 * unconfigured, unavailable, or the router is in shadow mode.
 *
 * Model-facing text, not user copy. Without it the model reads
 * `ATRIUM_DATA_AUTHORING_GUIDANCE` ("Explore the data with a couple of
 * queries"), finds no query tool, and invents column names anyway.
 *
 * Deliberately names NO specific control. An earlier draft told the model to
 * send the user to the Connect menu, which is an instruction many affected users
 * cannot follow: that menu renders only in Advanced mode, and where it does
 * render this very change locks the PSD Data row on, so there is nothing to
 * switch. Worse, most of the ways a turn lands here — the connector is
 * unconfigured, the user has no access to it, the MCP server is down, a skill's
 * tool pin stripped it — are not fixable from that menu at all. Handing someone
 * a remedy that cannot work is its own version of reporting success falsely, so
 * the model states the limit and asks, rather than prescribing a click.
 */
export const WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE =
  " PSD DATA TOOLS ARE NOT AVAILABLE ON THIS TURN: you have no way to list tables," +
  " inspect a schema, or run a query. Do NOT guess table or column names and do NOT" +
  " write or edit SQL you cannot verify. Keep any SQL already in the artifact exactly" +
  " as it is, and make only the changes you can make without knowing the schema." +
  " Then tell the user plainly that you could not reach the district data this turn," +
  " so you did not change anything that depends on the data schema, and ask them how" +
  " they would like to proceed. Do NOT tell them which setting to change: you cannot" +
  " see why the tools are missing, and the cause is often not something they can fix" +
  " themselves.";
