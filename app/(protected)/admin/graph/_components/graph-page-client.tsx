"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
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
  type NodeConnection,
} from "@/actions/graph.actions"
import type { SelectGraphNode, SelectGraphEdge } from "@/lib/db/types"

type ActiveTab = "nodes" | "edges"

export function GraphPageClient() {
  const { toast } = useToast()

  // Data state
  const [nodes, setNodes] = useState<SelectGraphNode[]>([])
  const [edges, setEdges] = useState<SelectGraphEdge[]>([])
  const [loading, setLoading] = useState(true)

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

  // Node form sheet state
  const [nodeFormOpen, setNodeFormOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<SelectGraphNode | null>(null)

  // Edge form sheet state
  const [edgeFormOpen, setEdgeFormOpen] = useState(false)

  // Node detail sheet state
  const [detailNode, setDetailNode] = useState<SelectGraphNode | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [connections, setConnections] = useState<NodeConnection[]>([])
  const [loadingConnections, setLoadingConnections] = useState(false)

  // Delete dialog state
  const [deleteNodeDialog, setDeleteNodeDialog] = useState(false)
  const [nodeToDelete, setNodeToDelete] = useState<SelectGraphNode | null>(null)
  const [deleteEdgeDialog, setDeleteEdgeDialog] = useState(false)
  const [edgeToDelete, setEdgeToDelete] = useState<EdgeTableRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Derived: unique node types and classes for filter dropdowns
  const nodeTypes = useMemo(
    () => [...new Set(nodes.map((n) => n.nodeType))].sort(),
    [nodes]
  )
  const nodeClasses = useMemo(
    () => [...new Set(nodes.map((n) => n.nodeClass))].sort(),
    [nodes]
  )
  const edgeTypes = useMemo(
    () => [...new Set(edges.map((e) => e.edgeType))].sort(),
    [edges]
  )

  // Node name lookup map for edge table display
  const nodeNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of nodes) {
      map.set(node.id, node.name)
    }
    return map
  }, [nodes])

  // Filtered nodes
  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (nodeFilters.search) {
        const search = nodeFilters.search.toLowerCase()
        if (
          !node.name.toLowerCase().includes(search) &&
          !(node.description || "").toLowerCase().includes(search)
        ) {
          return false
        }
      }
      if (
        nodeFilters.nodeType !== "all" &&
        node.nodeType !== nodeFilters.nodeType
      ) {
        return false
      }
      if (
        nodeFilters.nodeClass !== "all" &&
        node.nodeClass !== nodeFilters.nodeClass
      ) {
        return false
      }
      return true
    })
  }, [nodes, nodeFilters])

  // Filtered edges
  const filteredEdges = useMemo(() => {
    return edges.filter((edge) => {
      if (
        edgeFilters.edgeType !== "all" &&
        edge.edgeType !== edgeFilters.edgeType
      ) {
        return false
      }
      return true
    })
  }, [edges, edgeFilters])

  // Table rows
  const nodeTableRows: NodeTableRow[] = filteredNodes.map((node) => ({
    id: node.id,
    name: node.name,
    nodeType: node.nodeType,
    nodeClass: node.nodeClass,
    description: node.description,
    createdAt: node.createdAt,
  }))

  const edgeTableRows: EdgeTableRow[] = filteredEdges.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    sourceNodeName: nodeNameMap.get(edge.sourceNodeId) || "Unknown",
    targetNodeId: edge.targetNodeId,
    targetNodeName: nodeNameMap.get(edge.targetNodeId) || "Unknown",
    edgeType: edge.edgeType,
    createdAt: edge.createdAt,
  }))

  // Stats
  const stats = useMemo(
    () => ({
      totalNodes: nodes.length,
      totalEdges: edges.length,
      nodeTypes: nodeTypes.length,
    }),
    [nodes.length, edges.length, nodeTypes.length]
  )

  // ============================================
  // Data Loading
  // ============================================

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

  // ============================================
  // Node Handlers
  // ============================================

  const handleAddNode = useCallback(() => {
    setEditingNode(null)
    setNodeFormOpen(true)
  }, [])

  const handleViewNode = useCallback(
    async (row: NodeTableRow) => {
      const node = nodes.find((n) => n.id === row.id)
      if (!node) return

      setDetailNode(node)
      setDetailOpen(true)
      setLoadingConnections(true)

      try {
        const result = await getNodeConnections(node.id)
        if (result.isSuccess && result.data) {
          setConnections(result.data)
        }
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

  const handleEditNode = useCallback(
    (row: NodeTableRow) => {
      const node = nodes.find((n) => n.id === row.id)
      if (node) {
        setEditingNode(node)
        setNodeFormOpen(true)
      }
    },
    [nodes]
  )

  const handleEditFromDetail = useCallback((node: SelectGraphNode) => {
    setDetailOpen(false)
    setEditingNode(node)
    setNodeFormOpen(true)
  }, [])

  const handleDeleteNodeRequest = useCallback(
    (row: NodeTableRow | SelectGraphNode) => {
      const node = "nodeType" in row && "nodeClass" in row
        ? nodes.find((n) => n.id === row.id) || null
        : null
      if (node) {
        setNodeToDelete(node)
        setDeleteNodeDialog(true)
      }
    },
    [nodes]
  )

  const handleDeleteFromDetail = useCallback((node: SelectGraphNode) => {
    setDetailOpen(false)
    setNodeToDelete(node)
    setDeleteNodeDialog(true)
  }, [])

  const confirmDeleteNode = useCallback(async () => {
    if (!nodeToDelete) return

    setDeleting(true)
    try {
      const result = await deleteGraphNode(nodeToDelete.id)
      if (!result.isSuccess) {
        throw new Error(result.message || "Failed to delete node")
      }

      setNodes((prev) => prev.filter((n) => n.id !== nodeToDelete.id))
      // Also remove edges that referenced this node
      setEdges((prev) =>
        prev.filter(
          (e) =>
            e.sourceNodeId !== nodeToDelete.id &&
            e.targetNodeId !== nodeToDelete.id
        )
      )

      toast({
        title: "Success",
        description: "Node deleted successfully",
      })
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
  }, [nodeToDelete, toast])

  const handleSaveNode = useCallback(
    async (data: NodeFormData) => {
      let parsedMetadata = {}
      try {
        parsedMetadata = JSON.parse(data.metadata)
      } catch {
        // Default to empty
      }

      if (editingNode) {
        // Update existing node
        const result = await updateGraphNode(editingNode.id, {
          name: data.name,
          nodeType: data.nodeType,
          nodeClass: data.nodeClass,
          description: data.description || null,
          metadata: parsedMetadata,
        })

        if (!result.isSuccess) {
          toast({
            title: "Error",
            description: result.message || "Failed to update node",
            variant: "destructive",
          })
          throw new Error(result.message || "Failed to update node")
        }

        if (result.data) {
          setNodes((prev) =>
            prev.map((n) => (n.id === editingNode.id ? result.data! : n))
          )
        }

        toast({
          title: "Success",
          description: "Node updated successfully",
        })
      } else {
        // Create new node
        const result = await createGraphNode({
          name: data.name,
          nodeType: data.nodeType,
          nodeClass: data.nodeClass,
          description: data.description || undefined,
          metadata: parsedMetadata,
        })

        if (!result.isSuccess) {
          toast({
            title: "Error",
            description: result.message || "Failed to create node",
            variant: "destructive",
          })
          throw new Error(result.message || "Failed to create node")
        }

        if (result.data) {
          setNodes((prev) => [result.data!, ...prev])
        }

        toast({
          title: "Success",
          description: "Node created successfully",
        })
      }
    },
    [editingNode, toast]
  )

  // ============================================
  // Edge Handlers
  // ============================================

  const handleAddEdge = useCallback(() => {
    setEdgeFormOpen(true)
  }, [])

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

      setEdges((prev) => prev.filter((e) => e.id !== edgeToDelete.id))

      toast({
        title: "Success",
        description: "Edge deleted successfully",
      })
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
  }, [edgeToDelete, toast])

  const handleSaveEdge = useCallback(
    async (data: EdgeFormData) => {
      let parsedMetadata = {}
      try {
        parsedMetadata = JSON.parse(data.metadata)
      } catch {
        // Default to empty
      }

      const result = await createGraphEdge({
        sourceNodeId: data.sourceNodeId,
        targetNodeId: data.targetNodeId,
        edgeType: data.edgeType,
        metadata: parsedMetadata,
      })

      if (!result.isSuccess) {
        toast({
          title: "Error",
          description: result.message || "Failed to create edge",
          variant: "destructive",
        })
        throw new Error(result.message || "Failed to create edge")
      }

      if (result.data) {
        setEdges((prev) => [result.data!, ...prev])
      }

      toast({
        title: "Success",
        description: "Edge created successfully",
      })
    },
    [toast]
  )

  // ============================================
  // Render
  // ============================================

  return (
    <div className="p-6 space-y-6">
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
    </div>
  )
}
