/**
 * Unit tests for the Nexus chat multi-step budget (#1749 addendum C).
 *
 * A workspace BUILD turn explores the data before it writes any code, so ten
 * steps ended the turn with prose promising work that never happened. The budget
 * is a pure function precisely so this is testable without the chat request.
 */

import {
  DEFAULT_MAX_STEPS,
  WEB_FETCH_MAX_STEPS,
  WORKSPACE_MAX_STEPS,
  resolveMaxSteps,
} from "@/lib/nexus/chat-step-budget";

describe("resolveMaxSteps", () => {
  it("still allows a follow-up step when no multi-step tools are active (#1696)", () => {
    // The universal `web_fetch` tool is attached to EVERY turn and is not
    // terminal: without a follow-up step the model calls it and the turn ends
    // before it can answer from the page it just read.
    expect(
      resolveMaxSteps({ multiStepToolsActive: false, hasWorkspaceTools: false })
    ).toBe(WEB_FETCH_MAX_STEPS);
    expect(WEB_FETCH_MAX_STEPS).toBeGreaterThanOrEqual(2);
  });

  it("keeps the baseline budget far below the multi-step bounds (#1696)", () => {
    // The step budget scales the stream wall-clock ceiling, so an ordinary turn
    // must not inherit the ten-step tool-chain budget.
    expect(WEB_FETCH_MAX_STEPS).toBeLessThan(DEFAULT_MAX_STEPS);
  });

  it("keeps the original bound for non-workspace multi-step chains", () => {
    expect(
      resolveMaxSteps({ multiStepToolsActive: true, hasWorkspaceTools: false })
    ).toBe(DEFAULT_MAX_STEPS);
    expect(DEFAULT_MAX_STEPS).toBe(10);
  });

  it("widens the bound when workspace content tools are bound", () => {
    expect(
      resolveMaxSteps({ multiStepToolsActive: true, hasWorkspaceTools: true })
    ).toBe(WORKSPACE_MAX_STEPS);
    expect(WORKSPACE_MAX_STEPS).toBeGreaterThan(DEFAULT_MAX_STEPS);
  });

  it("does not widen to the workspace bound when multi-step is off (never a bypass)", () => {
    expect(
      resolveMaxSteps({ multiStepToolsActive: false, hasWorkspaceTools: true })
    ).toBe(WEB_FETCH_MAX_STEPS);
  });
});
