/**
 * How many tool-use steps a Nexus chat turn may take (the AI SDK agent loop).
 *
 * `undefined` means single-step: no multi-step tools are active, so the model
 * answers in one pass. Ten steps is the bound for a save/forget/read→edit→confirm
 * chain (MCP / repository / memory tools).
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

export function resolveMaxSteps(args: {
  multiStepToolsActive: boolean;
  hasWorkspaceTools: boolean;
}): number | undefined {
  if (!args.multiStepToolsActive) return undefined;
  return args.hasWorkspaceTools ? WORKSPACE_MAX_STEPS : DEFAULT_MAX_STEPS;
}
