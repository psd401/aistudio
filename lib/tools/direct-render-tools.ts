/**
 * Tools whose own output IS the answer.
 *
 * The Nexus thread renders these outside the collapsible "Tool Actions" card
 * (`app/(protected)/nexus/_components/tools/tool-group.tsx`), because the thing
 * the user asked for — a chart, a generated Word document, a decision card — is
 * the tool's rendered result, not a sentence about it. A turn that calls one of
 * these and then stops has genuinely answered.
 *
 * Shared with the streaming layer (#1899): `classifyEmptyTurn` must not tell
 * someone "the model used its tools but never wrote an answer" while their
 * download card sits right above the notice. Kept here, free of React imports,
 * so both the client component and the server-side adapter can use one list.
 */
export const DIRECT_RENDER_TOOL_NAMES = [
  "show_chart",
  "search_graph_nodes",
  "propose_decision",
  "commit_decision",
  // #1898: the download card IS the deliverable. Inside the collapsed "Tool
  // Actions" card the user would have to click "Show" to find the file they
  // asked for, and renderers mount only while expanded — so the card must
  // render directly.
  "generate_document",
] as const;

export type DirectRenderToolName = (typeof DIRECT_RENDER_TOOL_NAMES)[number];

const DIRECT_RENDER_TOOL_SET: ReadonlySet<string> = new Set(DIRECT_RENDER_TOOL_NAMES);

export function isDirectRenderTool(toolName: string): boolean {
  return DIRECT_RENDER_TOOL_SET.has(toolName);
}
