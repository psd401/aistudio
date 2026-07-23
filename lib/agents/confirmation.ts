/**
 * Destructive-tool confirmation contract (Issue #926).
 *
 * A pure, dependency-free module shared by the server (the agent tool resolver,
 * which gates destructive tools) and the client (the execution UI, which renders
 * a distinct "awaiting confirmation" timeline state). When a destructive tool is
 * invoked without per-run approval, the resolver returns a string starting with
 * {@link AGENT_CONFIRMATION_SENTINEL} instead of executing the tool; the UI detects
 * that prefix on the tool's output to show the confirmation state.
 */

export const AGENT_CONFIRMATION_SENTINEL = "⚠️ CONFIRMATION REQUIRED";

/** True when a tool result text is the resolver's confirmation-required marker. */
export function isConfirmationRequiredText(text: unknown): boolean {
  return (
    typeof text === "string" && text.startsWith(AGENT_CONFIRMATION_SENTINEL)
  );
}

/** Build the model-facing message returned when a destructive tool is gated. */
export function buildConfirmationMessage(toolName: string): string {
  return (
    `${AGENT_CONFIRMATION_SENTINEL}: the tool "${toolName}" performs a ` +
    `destructive action and was NOT executed because this run was not approved ` +
    `for destructive tool use. Do not retry it. Summarize what you would do with ` +
    `this tool and tell the user to re-run with destructive actions approved if ` +
    `they want it performed.`
  );
}
