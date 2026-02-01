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
  type GraphNodeFilters,
  type GraphEdgeFilters,
  type PaginationParams,
  type PaginatedResult,
  type CreateNodeInput,
  type UpdateNodeInput,
  type CreateEdgeInput,
  type NodeConnection,
} from "./graph-service"
