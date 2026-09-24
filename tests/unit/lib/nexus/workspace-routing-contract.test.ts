/** @jest-environment node */

/**
 * The do-not-guess trigger (#1786, issue item 3).
 *
 * `workspaceNeedsPsdData` decides whether the router ATTACHES the connector;
 * this predicate decides whether the chat route has to warn the model that it
 * did not get the tools anyway. The distinction is the whole point: the router
 * choosing a connector is not the same as that connector's tools binding, and
 * the failure this issue is about is precisely the model being told to "explore
 * the data with a couple of queries" with no query tool in hand — after which it
 * invented `school_name` and reported success.
 */

import type { McpConnectorToolsResult } from "@/lib/mcp/connector-types";
import {
  WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE,
  workspaceNeedsPsdData,
  workspacePsdDataToolsMissing,
  type NexusWorkspaceRoutingContext,
} from "@/lib/nexus/workspace-routing-contract";

const PSD = "psd-data-connector-id";

const EDITABLE_ARTIFACT: NexusWorkspaceRoutingContext = {
  objectId: "obj-1",
  kind: "artifact",
  editable: true,
};

function connectorResult(
  serverId: string,
  toolNames: string[]
): McpConnectorToolsResult {
  return {
    serverId,
    serverName: serverId,
    tools: Object.fromEntries(toolNames.map((name) => [name, {}])) as never,
    close: async () => undefined,
  };
}

const QUERY_TOOLS = connectorResult(PSD, [
  "list_available_tables",
  "inspect_table_schema",
  "query_data",
]);

describe("workspaceNeedsPsdData", () => {
  it("is true for an artifact the user can edit", () => {
    expect(workspaceNeedsPsdData(EDITABLE_ARTIFACT)).toBe(true);
  });

  it("is false for a document, which has no sandbox and no data bridge", () => {
    expect(
      workspaceNeedsPsdData({ ...EDITABLE_ARTIFACT, kind: "document" })
    ).toBe(false);
  });

  it("is false for a read-only viewer, who authors nothing", () => {
    expect(workspaceNeedsPsdData({ ...EDITABLE_ARTIFACT, editable: false })).toBe(
      false
    );
  });

  it("is false when no workspace is open", () => {
    expect(workspaceNeedsPsdData(null)).toBe(false);
    expect(workspaceNeedsPsdData(undefined)).toBe(false);
  });
});

describe("workspacePsdDataToolsMissing", () => {
  it("is false when the connector bound its tools — the model can verify the schema", () => {
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: PSD,
        connectorToolResults: [QUERY_TOOLS],
      })
    ).toBe(false);
  });

  it("is true when the router could not resolve a connector at all", () => {
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: null,
        connectorToolResults: [],
      })
    ).toBe(true);
  });

  it("is true when the connector never made it into the turn's results", () => {
    // Connector access, a failed MCP handshake, or the router running in
    // shadow/off mode — all land here.
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: PSD,
        connectorToolResults: [connectorResult("some-other-connector", ["x"])],
      })
    ).toBe(true);
  });

  it("is true when the connector bound ZERO tools — a row is not a tool", () => {
    // The regression this guards: a skill's `allowed-tools` pin can filter every
    // tool off a connector that connected perfectly well.
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: PSD,
        connectorToolResults: [connectorResult(PSD, [])],
      })
    ).toBe(true);
  });

  it("is true when the surviving tools cannot reveal a schema", () => {
    // A skill's `allowed-tools` pin can keep one unrelated tool off this
    // connector while dropping every data tool. Counting that as usable would
    // suppress the warning for a model that cannot read a schema at all.
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: PSD,
        connectorToolResults: [connectorResult(PSD, ["save_lesson"])],
      })
    ).toBe(true);
  });

  it("is true when only table NAMES survived — names are not columns", () => {
    // `list_available_tables` tells you a table exists, not that its column is
    // `location_code` rather than `school_name`. That substitution is the bug.
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: PSD,
        connectorToolResults: [connectorResult(PSD, ["list_available_tables"])],
      })
    ).toBe(true);
  });

  it.each(["inspect_table_schema", "query_data"])(
    "is false when %s survived — either one can verify a column",
    (tool) => {
      expect(
        workspacePsdDataToolsMissing({
          workspace: EDITABLE_ARTIFACT,
          connectorId: PSD,
          connectorToolResults: [connectorResult(PSD, [tool])],
        })
      ).toBe(false);
    }
  );

  it("is not fooled by inherited object properties", () => {
    // The tool set is keyed by names the connector supplies, so membership must
    // be an own-property check — `'constructor' in {}` is true.
    expect(
      workspacePsdDataToolsMissing({
        workspace: EDITABLE_ARTIFACT,
        connectorId: PSD,
        connectorToolResults: [connectorResult(PSD, ["constructor"])],
      })
    ).toBe(true);
  });

  it("never warns when the rule does not apply to this workspace", () => {
    for (const workspace of [
      null,
      { ...EDITABLE_ARTIFACT, kind: "document" as const },
      { ...EDITABLE_ARTIFACT, editable: false },
    ]) {
      expect(
        workspacePsdDataToolsMissing({
          workspace,
          connectorId: null,
          connectorToolResults: [],
        })
      ).toBe(false);
    }
  });
});

describe("WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE", () => {
  it("appends cleanly to an existing prompt fragment", () => {
    // It is concatenated onto the workspace fragment, so it must carry its own
    // leading separator rather than running into the previous sentence.
    expect(WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE.startsWith(" ")).toBe(true);
  });

  it("forbids guessing and requires telling the user", () => {
    expect(WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE).toMatch(/do not guess/i);
    expect(WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE).toMatch(/tell the user/i);
  });

  it("prescribes no specific control the user may not have", () => {
    // Most ways a turn lands here — unconfigured connector, no access, MCP down,
    // a skill tool pin — are not fixable from any menu, the Connect menu renders
    // only in Advanced mode, and where it renders this change locks the PSD Data
    // row on. Naming a control would hand the user a remedy that cannot work.
    expect(WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE).not.toMatch(/connect menu/i);
    expect(WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE).not.toMatch(/switch .* on/i);
    expect(WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE).toMatch(
      /do not tell them which setting to change/i
    );
  });
});
