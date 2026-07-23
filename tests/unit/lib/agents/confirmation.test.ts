/**
 * Destructive-tool confirmation contract (Issue #926).
 */
import {
  AGENT_CONFIRMATION_SENTINEL,
  isConfirmationRequiredText,
  buildConfirmationMessage,
} from "@/lib/agents/confirmation";

describe("confirmation contract", () => {
  it("buildConfirmationMessage starts with the sentinel and names the tool", () => {
    const msg = buildConfirmationMessage("capture_decision");
    expect(msg.startsWith(AGENT_CONFIRMATION_SENTINEL)).toBe(true);
    expect(msg).toContain("capture_decision");
  });

  it("isConfirmationRequiredText detects the sentinel prefix only", () => {
    expect(isConfirmationRequiredText(buildConfirmationMessage("x"))).toBe(true);
    expect(isConfirmationRequiredText(`${AGENT_CONFIRMATION_SENTINEL}: anything`)).toBe(true);
    expect(isConfirmationRequiredText("normal tool output")).toBe(false);
    expect(isConfirmationRequiredText(undefined)).toBe(false);
    expect(isConfirmationRequiredText(42)).toBe(false);
    expect(isConfirmationRequiredText({})).toBe(false);
  });
});
