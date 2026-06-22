/**
 * Agentic Assistant Runtime (Issue #926, Epic #922 workstream #4).
 *
 * Public surface for the agentic Assistant Architect mode: a model loop with
 * tool access resolved from the unified tool catalog (#924) + per-user MCP
 * connectors (#774), bounded by per-run step/timeout/cost limits.
 */

export {
  resolveAgentTools,
  closeAgentConnectorClients,
} from "./tool-resolver";
export {
  resolveAgentRunLimits,
  isCostCapExceeded,
  isAgentRateLimitExceeded,
  AGENT_RATE_LIMIT_WINDOW_MS,
} from "./limits";
export type { AgentLimitConfig } from "./limits";
export {
  AGENT_LIMIT_CEILINGS,
  AGENT_LIMIT_DEFAULTS,
} from "./types";
export type {
  ResolvedAgentTools,
  ResolveAgentToolsParams,
  ToolInvocationAudit,
  AgentRunLimits,
} from "./types";
export { extractImageInputParts, detectImageInput } from "./vision";
export type { ImageFilePart } from "./vision";
