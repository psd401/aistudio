/**
 * How many tool-use steps a Nexus chat turn may take (the AI SDK agent loop).
 *
 * Every turn now gets at least a small multi-step budget, because the universal
 * `web_fetch` tool (#1696) is attached to every turn and is NOT terminal: the
 * model calls it, then needs a further step to answer from what it read. Under
 * the old single-step budget a "summarize this link" turn stopped at the tool
 * call and the user got an empty reply. Ten steps is the bound for a
 * save/forget/read→edit→confirm chain (MCP / repository / memory tools).
 *
 * The floor is deliberately small rather than reusing `DEFAULT_MAX_STEPS`: the
 * step budget also scales the stream's wall-clock ceiling
 * (`timeoutMs × maxSteps` in `base-adapter.buildStreamDeadline`), so handing
 * every ordinary turn a ten-step budget would widen the hard abort ceiling
 * across all of Nexus for the sake of one tool.
 *
 * #1749: a workspace BUILD turn is a different shape. "Build me a dashboard
 * connected to the data MCP" explores the data with several connector calls
 * BEFORE it reads the artifact and writes the code — the reported repro spent
 * roughly seven exploration calls, then a read, then the update. One failed query
 * and a retry exhausted ten steps, and the turn ended with prose promising work
 * that never happened. Workspace tools therefore raise the bound to twenty.
 *
 * Extracted from the route so the budget is unit-testable without standing up the
 * whole chat request.
 */

/** Multi-step bound for MCP / repository / memory tool chains. */
export const DEFAULT_MAX_STEPS = 10;
/** Multi-step bound when workspace content tools are bound (explore-then-build). */
export const WORKSPACE_MAX_STEPS = 20;
/**
 * Floor applied to every turn for the always-on `web_fetch` tool: one step to
 * fetch, one to answer, and one spare so the model can follow a single link on
 * from the first page (a docs index to the page that actually has the answer).
 */
export const WEB_FETCH_MAX_STEPS = 3;

export function resolveMaxSteps(args: {
  multiStepToolsActive: boolean;
  hasWorkspaceTools: boolean;
}): number {
  if (!args.multiStepToolsActive) return WEB_FETCH_MAX_STEPS;
  return args.hasWorkspaceTools ? WORKSPACE_MAX_STEPS : DEFAULT_MAX_STEPS;
}
