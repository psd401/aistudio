/**
 * Unit tests for the Nexus chat multi-step budget (#1749 addendum C).
 *
 * A workspace BUILD turn explores the data before it writes any code, so ten
 * steps ended the turn with prose promising work that never happened. The budget
 * is a pure function precisely so this is testable without the chat request.
 */

import {
  DEFAULT_MAX_STEPS,
  WORKSPACE_MAX_STEPS,
  resolveMaxSteps,
} from "@/lib/nexus/chat-step-budget";

describe("resolveMaxSteps", () => {
  it("is undefined (single-step) when no multi-step tools are active", () => {
    expect(
      resolveMaxSteps({ multiStepToolsActive: false, hasWorkspaceTools: false })
    ).toBeUndefined();
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

  it("stays single-step for workspace tools when multi-step is off (never a bypass)", () => {
    expect(
      resolveMaxSteps({ multiStepToolsActive: false, hasWorkspaceTools: true })
    ).toBeUndefined();
  });
});
