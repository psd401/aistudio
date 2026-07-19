/**
 * Graph Service Barrel Export
 * Part of Epic #674 (External API Platform) - Issue #679
 */

export {
  queryGraphNodes,
  queryGraphNode,
  insertGraphNode,
  patchGraphNode,
  removeGraphNode,
  queryGraphEdges,
  insertGraphEdge,
  removeGraphEdge,
  queryNodeConnections,
  GraphServiceError,
  type PublicGraphNode,
  type GraphNodeFilters,
  type GraphEdgeFilters,
  type PaginationParams,
  type PaginatedResult,
  type CreateNodeInput,
  type UpdateNodeInput,
  type CreateEdgeInput,
  type NodeConnection,
} from "./graph-service"

/**
 * Decision Framework - Issue #680
 * Shared vocabulary and validation for decision capture across all channels.
 */
export {
  DECISION_NODE_TYPES,
  DECISION_NODE_TYPE_DESCRIPTIONS,
  DECISION_EDGE_TYPES,
  DECISION_EDGE_TYPE_DESCRIPTIONS,
  DEFAULT_DECISION_FRAMEWORK_PROMPT,
  DECISION_STATUSES,
  getDecisionFrameworkPrompt,
  isDecisionNodeType,
  isDecisionEdgeType,
  isDecisionStatus,
  validateDecisionCompleteness,
  type DecisionNodeType,
  type DecisionEdgeType,
  type DecisionStatus,
  type DecisionSubgraphNode,
  type DecisionSubgraphEdge,
  type DecisionCompletenessResult,
} from "./decision-framework"

/**
 * Decision API Translator - Issue #683
 * Structured decision payload → graph nodes + edges + completeness scoring.
 */
export {
  translatePayloadToGraph,
  computeRuleBasedScore,
  computeLlmScore,
  type DecisionApiPayload,
  type TranslatedNode,
  type TranslatedEdge,
  type TranslatedDecision,
  type CompletenessResult,
} from "./decision-api-translator"
