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
import {
  classifyEmptyTurn,
  emptyTurnNotice,
} from "@/lib/streaming/empty-turn-notice";

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

/**
 * #1899 case 2 — exhausting the budget must not end the turn in silence.
 *
 * Every budget this function can return is reachable with nothing but tool
 * calls, so each one must produce the step-budget notice rather than a blank
 * bubble. Pinned here, against the real budgets, because the bound and the
 * notice have to move together: raising `WEB_FETCH_MAX_STEPS` without this
 * would be the regression (the original bug was an ordinary three-step turn
 * spending every step on `web_fetch`).
 */
describe("a budget spent entirely on tool calls is explained (#1899)", () => {
  const budgets = [
    ["ordinary turn", resolveMaxSteps({ multiStepToolsActive: false, hasWorkspaceTools: false })],
    ["tool-chain turn", resolveMaxSteps({ multiStepToolsActive: true, hasWorkspaceTools: false })],
    ["workspace turn", resolveMaxSteps({ multiStepToolsActive: true, hasWorkspaceTools: true })],
  ] as const;

  it.each(budgets)("%s names the step budget, not a blank reply", (_label, maxSteps) => {
    const kind = classifyEmptyTurn({
      sawText: false,
      sawReasoning: false,
      sawFile: false,
      sawToolActivity: true,
      sawDeliverableTool: false,
      sawOtherRendered: false,
      completedSteps: maxSteps,
      maxSteps,
      requireTextPart: true,
    });

    expect(kind).toBe("step_budget_exhausted");
    expect(emptyTurnNotice("step_budget_exhausted")).toContain("tool steps");
  });

  it("still answers normally when the model wrote text within the budget", () => {
    expect(
      classifyEmptyTurn({
        sawText: true,
        sawReasoning: false,
        sawFile: false,
        sawToolActivity: true,
        sawDeliverableTool: false,
        sawOtherRendered: false,
        completedSteps: WEB_FETCH_MAX_STEPS,
        maxSteps: WEB_FETCH_MAX_STEPS,
        requireTextPart: true,
      })
    ).toBeNull();
  });
});
