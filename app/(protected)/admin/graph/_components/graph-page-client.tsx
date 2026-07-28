"use client"

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageBranding } from "@/components/ui/page-branding"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  IconRefresh,
  IconPlus,
  IconLink,
  IconGraph,
  IconRoute,
} from "@tabler/icons-react"

import { NodesDataTable, type NodeTableRow } from "./nodes-data-table"
import { EdgesDataTable, type EdgeTableRow } from "./edges-data-table"
import { NodeFilters, type NodeFiltersState } from "./graph-filters"
import { EdgeFilters, type EdgeFiltersState } from "./graph-filters"
import { NodeFormSheet, type NodeFormData } from "./node-form-sheet"
import { EdgeFormSheet, type EdgeFormData } from "./edge-form-sheet"
import { NodeDetailSheet } from "./node-detail-sheet"

import {
  getGraphNodes,
  getGraphEdges,
  createGraphNode,
  updateGraphNode,
  deleteGraphNode,
  createGraphEdge,
  deleteGraphEdge,
  getNodeConnections,
} from "@/actions/graph.actions"
import type { NodeConnection, PublicGraphNode } from "@/lib/graph"
import type { SelectGraphEdge } from "@/lib/db/types"

type ActiveTab = "nodes" | "edges"
type SetNodes = Dispatch<SetStateAction<PublicGraphNode[]>>
type SetEdges = Dispatch<SetStateAction<SelectGraphEdge[]>>

function filterNodes(
  nodes: PublicGraphNode[],
  filters: NodeFiltersState
): PublicGraphNode[] {
  return nodes.filter((node) => {
    if (filters.search) {
      const search = filters.search.toLowerCase()
      if (
        !node.name.toLowerCase().includes(search) &&
        !(node.description || "").toLowerCase().includes(search)
      ) {
        return false
      }
    }
    if (filters.nodeType !== "all" && node.nodeType !== filters.nodeType) {
      return false
    }
    if (filters.nodeClass !== "all" && node.nodeClass !== filters.nodeClass) {
      return false
    }
    return true
  })
}

function toNodeTableRow(node: PublicGraphNode): NodeTableRow {
  return {
    id: node.id,
    name: node.name,
    nodeType: node.nodeType,
    nodeClass: node.nodeClass,
    description: node.description,
    createdAt: node.createdAt,
  }
}

function toEdgeTableRow(
  edge: SelectGraphEdge,
  nodeNames: Map<string, string>
): EdgeTableRow {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    sourceNodeName: nodeNames.get(edge.sourceNodeId) || "Unknown",
    targetNodeId: edge.targetNodeId,
    targetNodeName: nodeNames.get(edge.targetNodeId) || "Unknown",
    edgeType: edge.edgeType,
    createdAt: edge.createdAt,
  }
}

function useGraphTableData(
  nodes: PublicGraphNode[],
  edges: SelectGraphEdge[],
  nodeFilters: NodeFiltersState,
  edgeFilters: EdgeFiltersState
) {
  return useMemo(() => {
    const nodeTypes = [...new Set(nodes.map((node) => node.nodeType))].sort()
    const nodeClasses = [...new Set(nodes.map((node) => node.nodeClass))].sort()
    const edgeTypes = [...new Set(edges.map((edge) => edge.edgeType))].sort()
    const nodeNames = new Map(nodes.map((node) => [node.id, node.name]))
    const filteredEdges =
      edgeFilters.edgeType === "all"
        ? edges
        : edges.filter((edge) => edge.edgeType === edgeFilters.edgeType)

    return {
      nodeTypes,
      nodeClasses,
      edgeTypes,
      nodeTableRows: filterNodes(nodes, nodeFilters).map(toNodeTableRow),
      edgeTableRows: filteredEdges.map((edge) =>
        toEdgeTableRow(edge, nodeNames)
      ),
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        nodeTypes: nodeTypes.length,
      },
    }
  }, [edgeFilters.edgeType, edges, nodeFilters, nodes])
}

function useGraphData() {
  const { toast } = useToast()
  const [nodes, setNodes] = useState<PublicGraphNode[]>([])
  const [edges, setEdges] = useState<SelectGraphEdge[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [nodesResult, edgesResult] = await Promise.all([
        getGraphNodes(),
        getGraphEdges(),
      ])
      if (nodesResult.isSuccess && nodesResult.data) {
        setNodes(nodesResult.data)
      } else if (!nodesResult.isSuccess) {
        toast({
          title: "Error",
          description: nodesResult.message || "Failed to load nodes",
          variant: "destructive",
        })
      }
      if (edgesResult.isSuccess && edgesResult.data) {
        setEdges(edgesResult.data)
      } else if (!edgesResult.isSuccess) {
        toast({
          title: "Error",
          description: edgesResult.message || "Failed to load edges",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to load graph data",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadData()
  }, [loadData])

  return { nodes, setNodes, edges, setEdges, loading, loadData }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function useNodeEditor(nodes: PublicGraphNode[], setNodes: SetNodes) {
  const { toast } = useToast()
  const [nodeFormOpen, setNodeFormOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<PublicGraphNode | null>(null)

  const openEditor = useCallback((node: PublicGraphNode | null) => {
    setEditingNode(node)
    setNodeFormOpen(true)
  }, [])
  const handleAddNode = useCallback(() => openEditor(null), [openEditor])
  const handleEditNode = useCallback(
    (row: NodeTableRow) => {
      const node = nodes.find((candidate) => candidate.id === row.id)
      if (node) openEditor(node)
    },
    [nodes, openEditor]
  )

  const handleSaveNode = useCallback(
    async (data: NodeFormData) => {
      const metadata = parseMetadata(data.metadata)
      const input = {
        name: data.name,
        nodeType: data.nodeType,
        nodeClass: data.nodeClass,
        description: data.description || null,
        metadata,
      }
      const result = editingNode
        ? await updateGraphNode(editingNode.id, input)
        : await createGraphNode({
            ...input,
            description: data.description || undefined,
          })
      if (!result.isSuccess) {
        const fallback = editingNode
          ? "Failed to update node"
          : "Failed to create node"
        toast({
          title: "Error",
          description: result.message || fallback,
          variant: "destructive",
        })
        throw new Error(result.message || fallback)
      }
      if (result.data) {
        const savedNode = result.data
        setNodes((previous) =>
          editingNode
            ? previous.map((node) =>
                node.id === editingNode.id ? savedNode : node
              )
            : [savedNode, ...previous]
        )
      }
      toast({
        title: "Success",
        description: editingNode
          ? "Node updated successfully"
          : "Node created successfully",
      })
    },
    [editingNode, setNodes, toast]
  )

  return {
    nodeFormOpen,
    setNodeFormOpen,
    editingNode,
    openEditor,
    handleAddNode,
    handleEditNode,
    handleSaveNode,
  }
}

function useNodeDetail(
  nodes: PublicGraphNode[],
  openEditor: (node: PublicGraphNode | null) => void
) {
  const { toast } = useToast()
  const [detailNode, setDetailNode] = useState<PublicGraphNode | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [connections, setConnections] = useState<NodeConnection[]>([])
  const [loadingConnections, setLoadingConnections] = useState(false)

  const handleViewNode = useCallback(
    async (row: NodeTableRow) => {
      const node = nodes.find((candidate) => candidate.id === row.id)
      if (!node) return
      setDetailNode(node)
      setDetailOpen(true)
      setLoadingConnections(true)
      try {
        const result = await getNodeConnections(node.id)
        if (result.isSuccess && result.data) setConnections(result.data)
      } catch {
        toast({
          title: "Error",
          description: "Failed to load connections",
          variant: "destructive",
        })
      } finally {
        setLoadingConnections(false)
      }
    },
    [nodes, toast]
  )
  const handleEditFromDetail = useCallback(
    (node: PublicGraphNode) => {
      setDetailOpen(false)
      openEditor(node)
    },
    [openEditor]
  )

  return {
    detailNode,
    detailOpen,
    setDetailOpen,
    connections,
    loadingConnections,
    handleViewNode,
    handleEditFromDetail,
  }
}

function useNodeDeletion(
  nodes: PublicGraphNode[],
  setNodes: SetNodes,
  setEdges: SetEdges,
  setDeleting: Dispatch<SetStateAction<boolean>>
) {
  const { toast } = useToast()
  const [deleteNodeDialog, setDeleteNodeDialog] = useState(false)
  const [nodeToDelete, setNodeToDelete] = useState<PublicGraphNode | null>(null)

  const requestNodeDeletion = useCallback((node: PublicGraphNode) => {
    setNodeToDelete(node)
    setDeleteNodeDialog(true)
  }, [])
  const handleDeleteNodeRequest = useCallback(
    (row: NodeTableRow) => {
      const node = nodes.find((candidate) => candidate.id === row.id)
      if (node) requestNodeDeletion(node)
    },
    [nodes, requestNodeDeletion]
  )
  const confirmDeleteNode = useCallback(async () => {
    if (!nodeToDelete) return
    setDeleting(true)
    try {
      const result = await deleteGraphNode(nodeToDelete.id)
      if (!result.isSuccess) {
        throw new Error(result.message || "Failed to delete node")
      }
      setNodes((previous) =>
        previous.filter((node) => node.id !== nodeToDelete.id)
      )
      setEdges((previous) =>
        previous.filter(
          (edge) =>
            edge.sourceNodeId !== nodeToDelete.id &&
            edge.targetNodeId !== nodeToDelete.id
        )
      )
      toast({ title: "Success", description: "Node deleted successfully" })
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete node",
        variant: "destructive",
      })
    } finally {
      setDeleting(false)
      setDeleteNodeDialog(false)
      setNodeToDelete(null)
    }
  }, [nodeToDelete, setDeleting, setEdges, setNodes, toast])

  return {
    deleteNodeDialog,
    setDeleteNodeDialog,
    nodeToDelete,
    requestNodeDeletion,
    handleDeleteNodeRequest,
    confirmDeleteNode,
  }
}

function useEdgeActions(
  setEdges: SetEdges,
  setDeleting: Dispatch<SetStateAction<boolean>>
) {
  const { toast } = useToast()
  const [edgeFormOpen, setEdgeFormOpen] = useState(false)
  const [deleteEdgeDialog, setDeleteEdgeDialog] = useState(false)
  const [edgeToDelete, setEdgeToDelete] = useState<EdgeTableRow | null>(null)

  const handleAddEdge = useCallback(() => setEdgeFormOpen(true), [])
  const handleDeleteEdgeRequest = useCallback((edge: EdgeTableRow) => {
    setEdgeToDelete(edge)
    setDeleteEdgeDialog(true)
  }, [])
  const confirmDeleteEdge = useCallback(async () => {
    if (!edgeToDelete) return
    setDeleting(true)
    try {
      const result = await deleteGraphEdge(edgeToDelete.id)
      if (!result.isSuccess) {
        throw new Error(result.message || "Failed to delete edge")
      }
      setEdges((previous) =>
        previous.filter((edge) => edge.id !== edgeToDelete.id)
      )
      toast({ title: "Success", description: "Edge deleted successfully" })
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete edge",
        variant: "destructive",
      })
    } finally {
      setDeleting(false)
      setDeleteEdgeDialog(false)
      setEdgeToDelete(null)
    }
  }, [edgeToDelete, setDeleting, setEdges, toast])
  const handleSaveEdge = useCallback(
    async (data: EdgeFormData) => {
      const result = await createGraphEdge({
        sourceNodeId: data.sourceNodeId,
        targetNodeId: data.targetNodeId,
        edgeType: data.edgeType,
        metadata: parseMetadata(data.metadata),
      })
      if (!result.isSuccess) {
        const message = result.message || "Failed to create edge"
        toast({ title: "Error", description: message, variant: "destructive" })
        throw new Error(message)
      }
      if (result.data) {
        const savedEdge = result.data
        setEdges((previous) => [savedEdge, ...previous])
      }
      toast({ title: "Success", description: "Edge created successfully" })
    },
    [setEdges, toast]
  )

  return {
    edgeFormOpen,
    setEdgeFormOpen,
    deleteEdgeDialog,
    setDeleteEdgeDialog,
    edgeToDelete,
    handleAddEdge,
    handleDeleteEdgeRequest,
    confirmDeleteEdge,
    handleSaveEdge,
  }
}

interface GraphHeaderAndStatsProps {
  activeTab: ActiveTab
  loading: boolean
  loadData: () => Promise<void>
  handleAddNode: () => void
  handleAddEdge: () => void
  stats: {
    totalNodes: number
    totalEdges: number
    nodeTypes: number
  }
}

function GraphHeaderAndStats({
  activeTab,
  loading,
  loadData,
  handleAddNode,
  handleAddEdge,
  stats,
}: GraphHeaderAndStatsProps) {
  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              Context Graph
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage graph nodes and their connections
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={loadData}
              disabled={loading}
            >
              <IconRefresh className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            {activeTab === "nodes" ? (
              <Button size="sm" onClick={handleAddNode}>
                <IconPlus className="h-4 w-4 mr-2" />
                Add Node
              </Button>
            ) : (
              <Button size="sm" onClick={handleAddEdge}>
                <IconLink className="h-4 w-4 mr-2" />
                Connect Nodes
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-24 bg-muted rounded-lg animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2">
              <IconGraph className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Total Nodes</p>
            </div>
            <p className="text-2xl font-semibold mt-2">{stats.totalNodes}</p>
          </div>
          <div className="p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2">
              <IconRoute className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Total Edges</p>
            </div>
            <p className="text-2xl font-semibold mt-2">{stats.totalEdges}</p>
          </div>
          <div className="p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2">
              <IconGraph className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Node Types</p>
            </div>
            <p className="text-2xl font-semibold mt-2">{stats.nodeTypes}</p>
          </div>
        </div>
      )}
    </>
  )
}

interface GraphDeleteDialogsProps {
  deleteNodeDialog: boolean
  setDeleteNodeDialog: Dispatch<SetStateAction<boolean>>
  nodeToDelete: PublicGraphNode | null
  deleteEdgeDialog: boolean
  setDeleteEdgeDialog: Dispatch<SetStateAction<boolean>>
  edgeToDelete: EdgeTableRow | null
  deleting: boolean
  confirmDeleteNode: () => Promise<void>
  confirmDeleteEdge: () => Promise<void>
}

function GraphDeleteDialogs({
  deleteNodeDialog,
  setDeleteNodeDialog,
  nodeToDelete,
  deleteEdgeDialog,
  setDeleteEdgeDialog,
  edgeToDelete,
  deleting,
  confirmDeleteNode,
  confirmDeleteEdge,
}: GraphDeleteDialogsProps) {
  return (
    <>
      {/* Delete Node Confirmation */}
      <AlertDialog open={deleteNodeDialog} onOpenChange={setDeleteNodeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Node</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{nodeToDelete?.name}
              &rdquo;? This will also delete all connected edges. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteNode}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Edge Confirmation */}
      <AlertDialog open={deleteEdgeDialog} onOpenChange={setDeleteEdgeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Edge</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this edge from &ldquo;
              {edgeToDelete?.sourceNodeName}&rdquo; to &ldquo;
              {edgeToDelete?.targetNodeName}&rdquo;? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteEdge}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function GraphPageClient() {

  const { nodes, setNodes, edges, setEdges, loading, loadData } = useGraphData()

  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>("nodes")

  // Filter state
  const [nodeFilters, setNodeFilters] = useState<NodeFiltersState>({
    search: "",
    nodeType: "all",
    nodeClass: "all",
  })
  const [edgeFilters, setEdgeFilters] = useState<EdgeFiltersState>({
    edgeType: "all",
  })

  const [deleting, setDeleting] = useState(false)
  const {
    nodeFormOpen,
    setNodeFormOpen,
    editingNode,
    openEditor,
    handleAddNode,
    handleEditNode,
    handleSaveNode,
  } = useNodeEditor(nodes, setNodes)
  const {
    detailNode,
    detailOpen,
    setDetailOpen,
    connections,
    loadingConnections,
    handleViewNode,
    handleEditFromDetail,
  } = useNodeDetail(nodes, openEditor)
  const {
    deleteNodeDialog,
    setDeleteNodeDialog,
    nodeToDelete,
    requestNodeDeletion,
    handleDeleteNodeRequest,
    confirmDeleteNode,
  } = useNodeDeletion(nodes, setNodes, setEdges, setDeleting)
  const {
    edgeFormOpen,
    setEdgeFormOpen,
    deleteEdgeDialog,
    setDeleteEdgeDialog,
    edgeToDelete,
    handleAddEdge,
    handleDeleteEdgeRequest,
    confirmDeleteEdge,
    handleSaveEdge,
  } = useEdgeActions(setEdges, setDeleting)
  const handleDeleteFromDetail = useCallback(
    (node: PublicGraphNode) => {
      setDetailOpen(false)
      requestNodeDeletion(node)
    },
    [requestNodeDeletion, setDetailOpen]
  )

  const {
    nodeTypes,
    nodeClasses,
    edgeTypes,
    nodeTableRows,
    edgeTableRows,
    stats,
  } = useGraphTableData(nodes, edges, nodeFilters, edgeFilters)

  // ============================================
  // Render
  // ============================================

  return (
    <div className="p-6 space-y-6">
      <GraphHeaderAndStats
        activeTab={activeTab}
        loading={loading}
        loadData={loadData}
        handleAddNode={handleAddNode}
        handleAddEdge={handleAddEdge}
        stats={stats}
      />



      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as ActiveTab)}
      >
        <TabsList>
          <TabsTrigger value="nodes">Nodes</TabsTrigger>
          <TabsTrigger value="edges">Edges</TabsTrigger>
        </TabsList>

        <TabsContent value="nodes" className="space-y-4 mt-4">
          <NodeFilters
            onFiltersChange={setNodeFilters}
            initialFilters={nodeFilters}
            nodeTypes={nodeTypes}
            nodeClasses={nodeClasses}
          />
          <NodesDataTable
            nodes={nodeTableRows}
            onViewNode={handleViewNode}
            onEditNode={handleEditNode}
            onDeleteNode={(row) => handleDeleteNodeRequest(row)}
            loading={loading}
          />
        </TabsContent>

        <TabsContent value="edges" className="space-y-4 mt-4">
          <EdgeFilters
            onFiltersChange={setEdgeFilters}
            initialFilters={edgeFilters}
            edgeTypes={edgeTypes}
          />
          <EdgesDataTable
            edges={edgeTableRows}
            onDeleteEdge={handleDeleteEdgeRequest}
            loading={loading}
          />
        </TabsContent>
      </Tabs>

      {/* Node Form Sheet */}
      <NodeFormSheet
        open={nodeFormOpen}
        onOpenChange={setNodeFormOpen}
        node={editingNode}
        onSave={handleSaveNode}
      />

      {/* Edge Form Sheet */}
      <EdgeFormSheet
        open={edgeFormOpen}
        onOpenChange={setEdgeFormOpen}
        nodes={nodes}
        onSave={handleSaveEdge}
      />

      {/* Node Detail Sheet */}
      <NodeDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        node={detailNode}
        connections={connections}
        loadingConnections={loadingConnections}
        onEdit={handleEditFromDetail}
        onDelete={handleDeleteFromDetail}
      />

      <GraphDeleteDialogs
        deleteNodeDialog={deleteNodeDialog}
        setDeleteNodeDialog={setDeleteNodeDialog}
        nodeToDelete={nodeToDelete}
        deleteEdgeDialog={deleteEdgeDialog}
        setDeleteEdgeDialog={setDeleteEdgeDialog}
        edgeToDelete={edgeToDelete}
        deleting={deleting}
        confirmDeleteNode={confirmDeleteNode}
        confirmDeleteEdge={confirmDeleteEdge}
      />

    </div>
  )
}
