'use client'

import { makeAssistantToolUI, type ToolCallMessagePartStatus } from '@assistant-ui/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertCircle, Search, GitBranch, Loader2, XCircle } from 'lucide-react'

/**
 * Decision Capture Tool UI Components
 *
 * Renders tool call results in the chat thread for:
 * - search_graph_nodes: Search results from the context graph
 * - propose_decision: Proposed decision subgraph with completeness status
 * - commit_decision: Commit confirmation
 * - validate_completeness: Completeness check results
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */

// ============================================================================
// Type Definitions
// ============================================================================

interface SearchGraphNodesArgs {
  query: string
  nodeType?: string
  limit?: number
}

interface SearchGraphNodesResult {
  nodes: Array<{
    id: string
    name: string
    nodeType: string
    nodeClass: string
    description: string | null
  }>
  total: number
}

interface ProposedNode {
  tempId: string
  name: string
  nodeType: string
  description: string | null
  existingNodeId?: string
}

interface ProposedEdge {
  sourceTempId: string
  targetTempId: string
  edgeType: string
}

interface ProposeDecisionArgs {
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  summary: string
}

interface ProposeDecisionResult {
  summary: string
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  completeness: {
    complete: boolean
    missing: string[]
  }
}

interface CommitDecisionArgs {
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  summary: string
}

interface CommitDecisionResult {
  success: boolean
  committedNodeIds: string[]
  committedEdgeIds: string[]
  error?: string
}

interface ValidateCompletenessArgs {
  nodes: Array<{ id: string; nodeType: string }>
  edges: Array<{ sourceNodeId: string; targetNodeId: string; edgeType: string }>
}

interface ValidateCompletenessResult {
  complete: boolean
  missing: string[]
}

// ============================================================================
// Node Type Colors
// ============================================================================

const NODE_TYPE_COLORS: Record<string, string> = {
  decision: 'bg-blue-100 text-blue-800',
  evidence: 'bg-green-100 text-green-800',
  constraint: 'bg-orange-100 text-orange-800',
  reasoning: 'bg-purple-100 text-purple-800',
  person: 'bg-pink-100 text-pink-800',
  condition: 'bg-yellow-100 text-yellow-800',
  request: 'bg-gray-100 text-gray-800',
  policy: 'bg-red-100 text-red-800',
  outcome: 'bg-teal-100 text-teal-800',
}

function NodeTypeBadge({ type }: { type: string }) {
  const colorClass = NODE_TYPE_COLORS[type] || 'bg-gray-100 text-gray-800'
  return (
    <Badge variant="secondary" className={`text-xs ${colorClass}`}>
      {type}
    </Badge>
  )
}

// ============================================================================
// Search Graph Nodes UI
// ============================================================================

const SearchResultsRenderer = ({
  args,
  result,
  status,
}: {
  args: SearchGraphNodesArgs
  result?: SearchGraphNodesResult
  status: ToolCallMessagePartStatus
}) => {
  if (status.type === 'running' || status.type === 'requires-action') {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-blue-600 animate-pulse" />
          <span className="text-sm text-blue-900">
            <span className="font-medium">Searching graph:</span> {args?.query || 'Loading...'}
          </span>
        </div>
      </div>
    )
  }

  if (status.type === 'incomplete' && status.reason === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
        <div className="flex items-center gap-2">
          <XCircle className="h-4 w-4 text-red-600" />
          <span className="text-sm text-red-900">Search failed for &quot;{args?.query}&quot;</span>
        </div>
      </div>
    )
  }

  const nodes = result?.nodes || []

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-medium text-blue-900">
            Graph search: &quot;{args?.query}&quot;
          </span>
        </div>
        <Badge variant="secondary" className="text-xs">
          {nodes.length} found
        </Badge>
      </div>
      {nodes.length > 0 && (
        <div className="space-y-1 mt-2">
          {nodes.map((node) => (
            <div key={node.id} className="flex items-center gap-2 text-xs text-blue-800">
              <NodeTypeBadge type={node.nodeType} />
              <span className="font-medium">{node.name}</span>
              {node.description && (
                <span className="text-blue-600 truncate">&mdash; {node.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const SearchGraphNodesUI = makeAssistantToolUI<SearchGraphNodesArgs, SearchGraphNodesResult>({
  toolName: 'search_graph_nodes',
  render: SearchResultsRenderer,
})

// ============================================================================
// Propose Decision UI
// ============================================================================

const ProposedDecisionRenderer = ({
  args,
  result,
  status,
}: {
  args: ProposeDecisionArgs
  result?: ProposeDecisionResult
  status: ToolCallMessagePartStatus
}) => {
  if (status.type === 'running' || status.type === 'requires-action') {
    return (
      <Card className="border-amber-200 bg-amber-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 text-amber-600 animate-spin" />
            <CardTitle className="text-sm text-amber-900">Preparing decision proposal...</CardTitle>
          </div>
        </CardHeader>
      </Card>
    )
  }

  if (status.type === 'incomplete' && status.reason === 'error') {
    return (
      <Card className="border-red-200 bg-red-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-600" />
            <CardTitle className="text-sm text-red-900">Failed to create proposal</CardTitle>
          </div>
        </CardHeader>
      </Card>
    )
  }

  const data = result || args
  const nodes = data?.nodes || []
  const edges = data?.edges || []
  const completeness = result?.completeness
  const summary = result?.summary || args?.summary || ''

  // Group nodes by type
  const groupedNodes = nodes.reduce<Record<string, typeof nodes>>((acc, node) => {
    const type = node.nodeType || 'unknown'
    if (!acc[type]) acc[type] = []
    acc[type].push(node)
    return acc
  }, {})

  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-amber-600" />
            <CardTitle className="text-sm text-amber-900">Proposed Decision</CardTitle>
          </div>
          {completeness && (
            <Badge
              variant="secondary"
              className={completeness.complete
                ? 'bg-green-100 text-green-800'
                : 'bg-yellow-100 text-yellow-800'
              }
            >
              {completeness.complete ? 'Complete' : 'Incomplete'}
            </Badge>
          )}
        </div>
        {summary && (
          <p className="text-xs text-amber-800 mt-1">{summary}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Nodes grouped by type */}
        {Object.entries(groupedNodes).map(([type, typeNodes]) => (
          <div key={type}>
            <div className="flex items-center gap-1 mb-1">
              <NodeTypeBadge type={type} />
              <span className="text-xs text-amber-700">({typeNodes.length})</span>
            </div>
            <div className="space-y-1 ml-2">
              {typeNodes.map((node) => (
                <div key={node.tempId} className="text-xs text-amber-900">
                  <span className="font-medium">{node.name}</span>
                  {node.existingNodeId && (
                    <span className="text-amber-600 ml-1">(existing)</span>
                  )}
                  {node.description && (
                    <span className="text-amber-700 block ml-2">{node.description}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Edges */}
        {edges.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-amber-900 mb-1">
              Relationships ({edges.length})
            </div>
            <div className="space-y-0.5 ml-2">
              {edges.map((edge, idx) => (
                <div key={idx} className="text-xs text-amber-800">
                  {edge.sourceTempId} <span className="font-medium">&rarr; {edge.edgeType} &rarr;</span> {edge.targetTempId}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completeness warnings */}
        {completeness && !completeness.complete && completeness.missing.length > 0 && (
          <div className="border-t border-amber-200 pt-2">
            <div className="flex items-center gap-1 text-xs font-semibold text-yellow-800 mb-1">
              <AlertCircle className="h-3 w-3" />
              Missing for completeness:
            </div>
            <ul className="space-y-0.5 ml-4">
              {completeness.missing.map((item, idx) => (
                <li key={idx} className="text-xs text-yellow-700 list-disc">{item}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export const ProposedDecisionUI = makeAssistantToolUI<ProposeDecisionArgs, ProposeDecisionResult>({
  toolName: 'propose_decision',
  render: ProposedDecisionRenderer,
})

// ============================================================================
// Commit Decision UI
// ============================================================================

const CommittedDecisionRenderer = ({
  args,
  result,
  status,
}: {
  args: CommitDecisionArgs
  result?: CommitDecisionResult
  status: ToolCallMessagePartStatus
}) => {
  if (status.type === 'running' || status.type === 'requires-action') {
    return (
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
            <CardTitle className="text-sm text-blue-900">Committing decision to graph...</CardTitle>
          </div>
        </CardHeader>
      </Card>
    )
  }

  if (status.type === 'incomplete' && status.reason === 'error') {
    return (
      <Card className="border-red-200 bg-red-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-600" />
            <CardTitle className="text-sm text-red-900">Failed to commit decision</CardTitle>
          </div>
        </CardHeader>
      </Card>
    )
  }

  if (result && !result.success) {
    return (
      <Card className="border-red-200 bg-red-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-600" />
            <CardTitle className="text-sm text-red-900">Commit failed</CardTitle>
          </div>
          {result.error && (
            <p className="text-xs text-red-700 mt-1">{result.error}</p>
          )}
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className="border-green-200 bg-green-50/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <CardTitle className="text-sm text-green-900">Decision committed</CardTitle>
          </div>
          <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">
            {result?.committedNodeIds?.length || 0} nodes, {result?.committedEdgeIds?.length || 0} edges
          </Badge>
        </div>
        <p className="text-xs text-green-700 mt-1">
          {args?.summary || 'Decision saved to context graph.'}
        </p>
      </CardHeader>
    </Card>
  )
}

export const CommittedDecisionUI = makeAssistantToolUI<CommitDecisionArgs, CommitDecisionResult>({
  toolName: 'commit_decision',
  render: CommittedDecisionRenderer,
})

// ============================================================================
// Validate Completeness UI
// ============================================================================

const ValidateCompletenessRenderer = ({
  result,
  status,
}: {
  args: ValidateCompletenessArgs
  result?: ValidateCompletenessResult
  status: ToolCallMessagePartStatus
}) => {
  if (status.type === 'running' || status.type === 'requires-action') {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 text-gray-600 animate-spin" />
          <span className="text-sm text-gray-900">Validating completeness...</span>
        </div>
      </div>
    )
  }

  if (!result) return null

  const isComplete = result.complete

  return (
    <div className={`rounded-lg border p-3 ${
      isComplete
        ? 'border-green-200 bg-green-50/50'
        : 'border-yellow-200 bg-yellow-50/50'
    }`}>
      <div className="flex items-center gap-2 mb-1">
        {isComplete ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : (
          <AlertCircle className="h-4 w-4 text-yellow-600" />
        )}
        <span className={`text-sm font-medium ${
          isComplete ? 'text-green-900' : 'text-yellow-900'
        }`}>
          {isComplete ? 'Decision is complete' : 'Decision is incomplete'}
        </span>
      </div>
      {!isComplete && result.missing.length > 0 && (
        <ul className="space-y-0.5 ml-6 mt-1">
          {result.missing.map((item, idx) => (
            <li key={idx} className="text-xs text-yellow-700 list-disc">{item}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const ValidateCompletenessUI = makeAssistantToolUI<ValidateCompletenessArgs, ValidateCompletenessResult>({
  toolName: 'validate_completeness',
  render: ValidateCompletenessRenderer,
})

// ============================================================================
// Wrapper Component
// ============================================================================

export function DecisionToolUIs() {
  return (
    <>
      <SearchGraphNodesUI />
      <ProposedDecisionUI />
      <CommittedDecisionUI />
      <ValidateCompletenessUI />
    </>
  )
}
