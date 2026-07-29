import "server-only";

/**
 * Unforgeable marker for trusted server-to-server assistant loads.
 *
 * Browser callers cannot serialize a Symbol through the server-action protocol.
 * Internal REST/MCP paths pass this marker only after their own authentication,
 * scope/capability, visibility, and shared resource checks.
 */
export const INTERNAL_ASSISTANT_LOOKUP = Symbol(
  "internal-assistant-lookup"
);
