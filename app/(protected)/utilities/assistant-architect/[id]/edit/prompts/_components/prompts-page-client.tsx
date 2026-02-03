"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { createLogger } from "@/lib/client-logger"
import { addChainPromptAction, deletePromptAction, updatePromptAction, getAssistantArchitectByIdAction, setPromptPositionsAction } from "@/actions/db/assistant-architect-actions"
import { PlusIcon, Pencil, Trash2, Play, Globe, Code2, Image as ImageIcon } from "lucide-react"
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Node,
  Edge,
  Connection,
  EdgeChange,
  Handle,
  Position,
  NodeProps,
  useReactFlow,
  ReactFlowProvider,
  Panel
} from '@xyflow/react'
import "@xyflow/react/dist/style.css"
import { Badge } from "@/components/ui/badge"
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
import type { SelectAiModel, SelectChainPrompt, SelectToolInputField } from "@/types"
import React from "react"
import { PromptEditorModal } from "@/components/features/assistant-architect/prompt-editor-modal"

// Parallel group multiplier constant - supports up to 1000 nodes per position level
// Used to encode position into parallel group ID: (position * MULTIPLIER + index)
const PARALLEL_GROUP_MULTIPLIER = 1000;

// Client-side logger for this component
const log = createLogger({ component: "PromptsPageClient" })

interface PromptsPageClientProps {
  assistantId: string
  prompts: SelectChainPrompt[]
  models: SelectAiModel[]
  inputFields: SelectToolInputField[]
}

// Start Node Component
function StartNode() {
  return (
    <div className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium flex items-center gap-2">
      <Play className="h-4 w-4" />
      Start
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-primary-foreground" />
    </div>
  )
}

interface PromptNodeData {
  name: string;
  content: string;
  modelName: string;
  systemContext?: string;
  modelId: number;
  inputMapping?: unknown;
  enabledTools?: string[];
  prompt: SelectChainPrompt;
  onEdit: (prompt: SelectChainPrompt) => void;
  onDelete: (id: string) => void;
}

// Custom Node Component with proper typing
// Note: ReactFlow NodeProps data is typed as Record<string, unknown>
// We use type assertion since we control the data shape when creating nodes
function PromptNode({ data, id }: NodeProps) {
  // Type assertion - ReactFlow's generic typing doesn't support custom data shapes well
  // The data shape is guaranteed by initializeFlowFromPrompts which creates the nodes
  const nodeData = data as unknown as PromptNodeData

  const handleEdit = useCallback(() => {
    if (nodeData.onEdit && nodeData.prompt) {
      nodeData.onEdit(nodeData.prompt)
    }
  }, [nodeData])

  const handleDelete = useCallback(() => {
    if (nodeData.onDelete && id) {
      nodeData.onDelete(id)
    }
  }, [nodeData, id])

  return (
    <div className="min-w-[200px] shadow-lg rounded-lg bg-background border">
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-base">{nodeData.name}</div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleEdit}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Badge variant="secondary" className="text-xs">
          {nodeData.modelName}
        </Badge>

        {nodeData.enabledTools && nodeData.enabledTools.length > 0 && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {nodeData.enabledTools.includes('webSearch') && (
              <Badge variant="outline" className="text-xs px-1 py-0 h-5">
                <Globe className="h-3 w-3 mr-1" />
                Web
              </Badge>
            )}
            {nodeData.enabledTools.includes('codeInterpreter') && (
              <Badge variant="outline" className="text-xs px-1 py-0 h-5">
                <Code2 className="h-3 w-3 mr-1" />
                Code
              </Badge>
            )}
            {nodeData.enabledTools.includes('generateImage') && (
              <Badge variant="outline" className="text-xs px-1 py-0 h-5">
                <ImageIcon className="h-3 w-3 mr-1" />
                Image
              </Badge>
            )}
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-primary" />
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-primary" />
    </div>
  )
}

const nodeTypes = {
  prompt: PromptNode,
  start: StartNode
}

interface FlowHandle {
  getNodes: () => Node[];
  getEdges: () => Edge[];
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  savePositions: () => Promise<void>;
}

interface FlowProps {
  assistantId: string
  prompts: SelectChainPrompt[]
  models: SelectAiModel[]
  onEdit: (prompt: SelectChainPrompt) => void
  onDelete: (id: string) => void
}

// Helper to create edges for branching (one to many)
function createBranchingEdges(sourceId: string, targetPrompts: SelectChainPrompt[]): Edge[] {
  return targetPrompts.map(targetPrompt => ({
    id: `e-${sourceId}-${String(targetPrompt.id)}`,
    source: sourceId,
    target: String(targetPrompt.id),
    type: 'smoothstep'
  }))
}

// Helper to create edges for merging (many to one)
function createMergingEdges(sourcePrompts: SelectChainPrompt[], targetId: string): Edge[] {
  return sourcePrompts.map(sourcePrompt => ({
    id: `e-${String(sourcePrompt.id)}-${targetId}`,
    source: String(sourcePrompt.id),
    target: targetId,
    type: 'smoothstep'
  }))
}

// Helper to create edges for parallel paths using parallel groups
function createParallelEdges(
  currentPrompts: SelectChainPrompt[],
  nextPrompts: SelectChainPrompt[],
  useParallelGroups: boolean
): Edge[] {
  const edges: Edge[] = []

  if (useParallelGroups) {
    for (const sourcePrompt of currentPrompts) {
      const sourceGroupIndex = sourcePrompt.parallelGroup !== null
        ? (sourcePrompt.parallelGroup % PARALLEL_GROUP_MULTIPLIER)
        : -1
      for (const targetPrompt of nextPrompts) {
        const targetGroupIndex = targetPrompt.parallelGroup !== null
          ? (targetPrompt.parallelGroup % PARALLEL_GROUP_MULTIPLIER)
          : -1
        if (sourceGroupIndex !== -1 && sourceGroupIndex === targetGroupIndex) {
          edges.push({
            id: `e-${String(sourcePrompt.id)}-${String(targetPrompt.id)}`,
            source: String(sourcePrompt.id),
            target: String(targetPrompt.id),
            type: 'smoothstep'
          })
        }
      }
    }
  } else {
    // Fallback: connect all to all
    for (const sourcePrompt of currentPrompts) {
      for (const targetPrompt of nextPrompts) {
        edges.push({
          id: `e-${String(sourcePrompt.id)}-${String(targetPrompt.id)}`,
          source: String(sourcePrompt.id),
          target: String(targetPrompt.id),
          type: 'smoothstep'
        })
      }
    }
  }

  return edges
}

// Helper to calculate execution order from graph structure
function calculateGraphExecutionOrder(
  nodes: Node[],
  edges: Edge[]
): { id: string; position: number; parallelGroup: number | null }[] {
  const startNode = nodes.find(n => n.type === 'start')
  if (!startNode) return []

  const nodeLevels = new Map<string, number>()
  const visited = new Set<string>()
  const getOutgoingEdges = (nodeId: string) => edges.filter(e => e.source === nodeId)

  // BFS to calculate levels
  const queue = [{ id: 'start', level: -1 }]
  while (queue.length > 0) {
    const { id, level } = queue.shift()!

    if (visited.has(id)) {
      nodeLevels.set(id, Math.max(level, nodeLevels.get(id) || 0))
      continue
    }

    visited.add(id)
    nodeLevels.set(id, level)

    for (const edge of getOutgoingEdges(id)) {
      queue.push({ id: edge.target, level: level + 1 })
    }
  }

  // Group nodes by position
  const nodesByPosition = new Map<number, string[]>()
  for (const [id, level] of nodeLevels.entries()) {
    if (id === 'start') continue
    if (!nodesByPosition.has(level)) nodesByPosition.set(level, [])
    nodesByPosition.get(level)?.push(id)
  }

  // Calculate parallel groups
  const nodeParallelGroups = new Map<string, number | null>()
  for (const [position, nodeIds] of nodesByPosition.entries()) {
    if (nodeIds.length === 1) {
      nodeParallelGroups.set(nodeIds[0], null)
    } else {
      const nodesWithEdgeInfo = nodeIds.map(nodeId => {
        const incomingEdges = edges.filter(e => e.target === nodeId)
        return { nodeId, sourceIds: incomingEdges.map(e => e.source).sort().join(',') }
      })
      nodesWithEdgeInfo.sort((a, b) =>
        a.sourceIds !== b.sourceIds
          ? a.sourceIds.localeCompare(b.sourceIds)
          : a.nodeId.localeCompare(b.nodeId)
      )
      for (const [i, element] of nodesWithEdgeInfo.entries()) {
        nodeParallelGroups.set(element.nodeId, position * PARALLEL_GROUP_MULTIPLIER + i)
      }
    }
  }

  return Array.from(nodeLevels.entries())
    .filter(([id]) => id !== 'start')
    .map(([id, level]) => ({
      id,
      position: level,
      parallelGroup: nodeParallelGroups.get(id) ?? null
    }))
}

// Helper to initialize flow nodes and edges from prompts
interface InitializeFlowResult {
  nodes: Node[]
  edges: Edge[]
}

function initializeFlowFromPrompts(
  prompts: SelectChainPrompt[],
  models: SelectAiModel[],
  onEdit: (prompt: SelectChainPrompt) => void,
  onDelete: (id: string) => void
): InitializeFlowResult {
  const startNode: Node = {
    id: 'start',
    type: 'start',
    position: { x: 250, y: 0 },
    data: {}
  }

  if (prompts.length === 0) {
    return { nodes: [startNode], edges: [] }
  }

  // Group by position
  const promptsByPosition = prompts.reduce((acc, prompt) => {
    const position = prompt.position || 0
    if (!acc[position]) acc[position] = []
    acc[position].push(prompt)
    return acc
  }, {} as Record<number, SelectChainPrompt[]>)

  const positions = Object.keys(promptsByPosition).map(Number).sort((a, b) => a - b)
  const horizontalSpacing = 300
  const verticalSpacing = 150

  // Create nodes
  const promptNodes: Node[] = []
  for (const [rowIndex, position] of positions.entries()) {
    const promptsAtPosition = promptsByPosition[position]
    const rowY = (rowIndex + 1) * verticalSpacing
    for (const [colIndex, prompt] of promptsAtPosition.entries()) {
      const centerOffset = ((promptsAtPosition.length - 1) * horizontalSpacing) / 2
      promptNodes.push({
        id: String(prompt.id),
        type: 'prompt' as const,
        position: { x: 250 + (colIndex * horizontalSpacing) - centerOffset, y: rowY },
        data: {
          name: prompt.name,
          content: prompt.content,
          modelName: models.find(m => m.id === prompt.modelId)?.name || 'None',
          systemContext: prompt.systemContext,
          modelId: prompt.modelId,
          inputMapping: prompt.inputMapping,
          enabledTools: prompt.enabledTools,
          prompt,
          onEdit,
          onDelete
        }
      })
    }
  }

  // Create edges
  const newEdges: Edge[] = []
  if (promptsByPosition[0]) {
    for (const prompt of promptsByPosition[0]) {
      newEdges.push({
        id: `e-start-${String(prompt.id)}`,
        source: 'start',
        target: String(prompt.id),
        type: 'smoothstep'
      })
    }
  }

  for (let i = 0; i < positions.length - 1; i++) {
    const currentPrompts = promptsByPosition[positions[i]]
    const nextPrompts = promptsByPosition[positions[i + 1]]
    const hasParallelInfo = currentPrompts.some(p => p.parallelGroup !== null) &&
                            nextPrompts.some(p => p.parallelGroup !== null)

    if (currentPrompts.length === 1 && nextPrompts.length > 1) {
      newEdges.push(...createBranchingEdges(String(currentPrompts[0].id), nextPrompts))
    } else if (currentPrompts.length > 1 && nextPrompts.length === 1) {
      newEdges.push(...createMergingEdges(currentPrompts, String(nextPrompts[0].id)))
    } else {
      newEdges.push(...createParallelEdges(currentPrompts, nextPrompts, hasParallelInfo))
    }
  }

  return { nodes: [startNode, ...promptNodes], edges: newEdges }
}

// Convert Flow to a forwardRef component using function declaration
function FlowComponent({
  assistantId,
  prompts,
  models,
  onEdit,
  onDelete
}: FlowProps, ref: React.ForwardedRef<FlowHandle>) {
  const initialNodes: Node[] = []
  const initialEdges: Edge[] = []
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, _onEdgesChange] = useEdgesState(initialEdges)
  const [isSaving, setIsSaving] = useState(false)
  const reactFlowInstance = useReactFlow()
  const isInitialRender = useRef(true)
  const initialPositionsSet = useRef(false)

  // Expose methods to parent via ref
  React.useImperativeHandle(ref, () => ({
    getNodes: () => reactFlowInstance.getNodes(),
    getEdges: () => reactFlowInstance.getEdges(),
    setNodes: (newNodes: Node[]) => reactFlowInstance.setNodes(newNodes),
    setEdges: (newEdges: Edge[]) => reactFlowInstance.setEdges(newEdges),
    savePositions: () => savePositions()
  }));

  // Calculate execution order using extracted helper
  const calculateExecutionOrder = useCallback(() => {
    return calculateGraphExecutionOrder(reactFlowInstance.getNodes(), reactFlowInstance.getEdges())
  }, [reactFlowInstance]);

  // Save positions to database
  const savePositions = useCallback(async () => {
    setIsSaving(true);
    try {
      const order = calculateExecutionOrder();
      if (order.length === 0) return  // finally block will handle cleanup
      // Transaction update
      await setPromptPositionsAction(assistantId, order);
      toast.success("Graph structure saved");
    } catch (error) {
      log.error("Failed to save graph structure", { error })
      toast.error("Failed to save graph structure")
    }
    finally { setIsSaving(false);} 
  }, [calculateExecutionOrder, assistantId]);

  // Handle edge changes and update positions
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    _onEdgesChange(changes)
    
    // Only save when edges are added or removed
    const hasStructuralChanges = changes.some((change) => 
      change.type === 'remove' || change.type === 'add'
    )
    if (hasStructuralChanges && !isInitialRender.current) {
      savePositions()
    }
  }, [_onEdgesChange, savePositions])

  // Handle new connections
  const onConnect = useCallback((params: Connection) => {
    setEdges(eds => addEdge(params, eds))
    if (!isInitialRender.current) {
      savePositions()
    }
  }, [setEdges, savePositions])

  // Initialize nodes and edges on first load only
  useEffect(() => {
    if (initialPositionsSet.current) return

    const { nodes: initializedNodes, edges: initializedEdges } = initializeFlowFromPrompts(
      prompts,
      models,
      onEdit,
      onDelete
    )

    setNodes(initializedNodes)
    setEdges(initializedEdges)
    initialPositionsSet.current = true

    // After a short delay, we're no longer in initial render state
    setTimeout(() => {
      isInitialRender.current = false
    }, 500)
  }, [prompts, models, onEdit, onDelete, setNodes, setEdges])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
      <Panel position="bottom-center" className="bg-background/80 p-2 rounded-lg shadow-lg">
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          {isSaving ? (
            <>
              <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              Saving changes...
            </>
          ) : (
            'Drag between nodes to create connections. The execution order follows the graph structure.'
          )}
        </div>
      </Panel>
    </ReactFlow>
  )
}

const Flow = React.forwardRef(FlowComponent)
Flow.displayName = 'Flow'

// Custom hook for prompt form state management
function usePromptFormState() {
  const [promptName, setPromptName] = useState("")
  const [promptContent, setPromptContent] = useState("")
  const [systemContext, setSystemContext] = useState("")
  const [modelId, setModelId] = useState<string | null>(null)
  const [useExternalKnowledge, setUseExternalKnowledge] = useState(false)
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [editingPrompt, setEditingPrompt] = useState<SelectChainPrompt | null>(null)

  const resetFormState = useCallback(() => {
    setPromptName("")
    setPromptContent("")
    setSystemContext("")
    setModelId(null)
    setUseExternalKnowledge(false)
    setSelectedRepositoryIds([])
    setEnabledTools([])
    setEditingPrompt(null)
  }, [])

  const populateFromPrompt = useCallback((prompt: SelectChainPrompt) => {
    setPromptName(prompt.name)
    setPromptContent(prompt.content)
    setSystemContext(prompt.systemContext || "")
    setModelId(prompt.modelId ? prompt.modelId.toString() : null)
    setUseExternalKnowledge(Boolean(prompt.repositoryIds && prompt.repositoryIds.length > 0))
    setSelectedRepositoryIds(prompt.repositoryIds || [])
    setEnabledTools(prompt.enabledTools || [])
    setEditingPrompt(prompt)
  }, [])

  return {
    promptName, setPromptName,
    promptContent, setPromptContent,
    systemContext, setSystemContext,
    modelId, setModelId,
    useExternalKnowledge, setUseExternalKnowledge,
    selectedRepositoryIds, setSelectedRepositoryIds,
    enabledTools, setEnabledTools,
    editingPrompt, setEditingPrompt,
    resetFormState, populateFromPrompt
  }
}

// Return type for usePromptFormState
type PromptFormState = ReturnType<typeof usePromptFormState>

// Props for usePromptHandlers
interface UsePromptHandlersProps {
  assistantId: string
  form: PromptFormState
  prompts: SelectChainPrompt[]
  setPrompts: React.Dispatch<React.SetStateAction<SelectChainPrompt[]>>
  setFlowKey: React.Dispatch<React.SetStateAction<number>>
  setIsAddDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  setIsEditDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>
  reactFlowInstanceRef: React.RefObject<FlowHandle | null>
  setDeletePromptId: React.Dispatch<React.SetStateAction<string | null>>
  setShowDeleteDialog: React.Dispatch<React.SetStateAction<boolean>>
}

// Custom hook for prompt CRUD handlers
function usePromptHandlers({
  assistantId, form, prompts, setPrompts, setFlowKey,
  setIsAddDialogOpen, setIsEditDialogOpen, setIsLoading, reactFlowInstanceRef,
  setDeletePromptId, setShowDeleteDialog
}: UsePromptHandlersProps) {
  const handleAddPrompt = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      if (!form.modelId) {
        toast.error("You must select a model for the prompt.")
        setIsLoading(false)
        return
      }
      const result = await addChainPromptAction(assistantId, {
        name: form.promptName,
        content: form.promptContent,
        systemContext: form.systemContext || undefined,
        modelId: Number.parseInt(form.modelId),
        position: prompts.length,
        repositoryIds: form.useExternalKnowledge ? form.selectedRepositoryIds : [],
        enabledTools: form.enabledTools,
      })
      if (result.isSuccess) {
        toast.success("Prompt added successfully")
        setIsAddDialogOpen(false)
        form.resetFormState()
        const updatedResult = await getAssistantArchitectByIdAction(assistantId)
        if (updatedResult.isSuccess && updatedResult.data?.prompts) {
          setPrompts(updatedResult.data.prompts as SelectChainPrompt[])
          setFlowKey(k => k + 1)
        }
      } else { toast.error(result.message) }
    } catch (error) {
      log.error("Failed to add prompt", { error, assistantId })
      toast.error("Failed to add prompt")
    } finally { setIsLoading(false) }
  }, [assistantId, form, prompts.length, setIsLoading, setIsAddDialogOpen, setPrompts, setFlowKey])

  const handleEditPrompt = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.editingPrompt) return
    setIsLoading(true)
    try {
      if (!form.modelId) {
        toast.error("You must select a model for the prompt.")
        setIsLoading(false)
        return
      }
      const result = await updatePromptAction(form.editingPrompt.id.toString(), {
        name: form.promptName,
        content: form.promptContent,
        systemContext: form.systemContext || undefined,
        modelId: Number.parseInt(form.modelId),
        repositoryIds: form.useExternalKnowledge && form.selectedRepositoryIds.length > 0
          ? form.selectedRepositoryIds.filter(id => id !== undefined && id !== null) : [],
        enabledTools: form.enabledTools,
      })
      if (result.isSuccess) {
        toast.success("Prompt updated successfully")
        setIsEditDialogOpen(false)
        setPrompts(currentPrompts =>
          currentPrompts.map(p =>
            p.id === form.editingPrompt?.id && result.data ? (result.data as SelectChainPrompt) : p
          )
        )
        setFlowKey(k => k + 1)
        form.resetFormState()
      } else { toast.error(result.message) }
    } catch (error) {
      log.error("Failed to update prompt", { error, promptId: form.editingPrompt?.id })
      toast.error("Failed to update prompt")
    } finally { setIsLoading(false) }
  }, [form, setIsLoading, setIsEditDialogOpen, setPrompts, setFlowKey])

  // Show delete confirmation dialog (non-blocking)
  const handleDeletePrompt = useCallback((promptId: string) => {
    setDeletePromptId(promptId)
    setShowDeleteDialog(true)
  }, [setDeletePromptId, setShowDeleteDialog])

  // Actually perform the delete after user confirms
  const confirmDeletePrompt = useCallback(async (promptId: string) => {
    try {
      const result = await deletePromptAction(promptId)
      if (result.isSuccess) {
        toast.success("Prompt deleted successfully")
        const promptIdInt = Number.parseInt(promptId, 10)
        setPrompts(current => current.filter(p => p.id !== promptIdInt))
        if (reactFlowInstanceRef.current) {
          const graphInstance = reactFlowInstanceRef.current
          // Use requestAnimationFrame to wait for React state to settle
          requestAnimationFrame(() => {
            graphInstance.setNodes(graphInstance.getNodes().filter(n => n.id !== promptId))
            graphInstance.setEdges(graphInstance.getEdges().filter(
              e => e.source !== promptId && e.target !== promptId
            ))
            // Second frame to ensure graph updates are applied before saving
            requestAnimationFrame(() => {
              reactFlowInstanceRef.current?.savePositions()
            })
          })
        }
      } else { toast.error(result.message) }
    } catch (error) {
      log.error("Failed to delete prompt", { error, promptId })
      toast.error("Failed to delete prompt")
    }
  }, [setPrompts, reactFlowInstanceRef])

  const openEditDialog = useCallback(async (prompt: SelectChainPrompt) => {
    setIsLoading(true)
    try {
      const result = await getAssistantArchitectByIdAction(assistantId)
      let latestPrompt = prompt
      if (result.isSuccess && result.data?.prompts) {
        const found = result.data.prompts.find((p: SelectChainPrompt) => p.id === prompt.id)
        if (found) latestPrompt = found
      }
      form.populateFromPrompt(latestPrompt)
      setIsEditDialogOpen(true)
    } catch (error) {
      log.error("Failed to fetch latest prompt data", { error, assistantId, promptId: prompt.id })
      toast.error("Failed to fetch latest prompt data")
      setIsEditDialogOpen(true)
    } finally { setIsLoading(false) }
  }, [assistantId, form, setIsLoading, setIsEditDialogOpen])

  return { handleAddPrompt, handleEditPrompt, handleDeletePrompt, confirmDeletePrompt, openEditDialog }
}

export function PromptsPageClient({ assistantId, prompts: initialPrompts, models, inputFields }: PromptsPageClientProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [prompts, setPrompts] = useState<SelectChainPrompt[]>(initialPrompts)
  const [flowKey, setFlowKey] = useState(0)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deletePromptId, setDeletePromptId] = useState<string | null>(null)
  const reactFlowInstanceRef = useRef<FlowHandle>(null)
  const form = usePromptFormState()

  useEffect(() => { setPrompts(initialPrompts) }, [initialPrompts])

  const { handleAddPrompt, handleEditPrompt, handleDeletePrompt, confirmDeletePrompt, openEditDialog } = usePromptHandlers({
    assistantId, form, prompts, setPrompts, setFlowKey,
    setIsAddDialogOpen, setIsEditDialogOpen, setIsLoading, reactFlowInstanceRef,
    setDeletePromptId, setShowDeleteDialog
  })

  const handleAddButtonClick = useCallback(() => {
    form.resetFormState()
    setIsAddDialogOpen(true)
  }, [form])
  const handleAddDialogOpenChange = useCallback((open: boolean) => {
    setIsAddDialogOpen(open)
    if (!open) form.resetFormState()
  }, [form])
  const handleEditDialogOpenChange = useCallback((open: boolean) => {
    setIsEditDialogOpen(open)
    if (!open) form.resetFormState()
  }, [form])

  const handleDeleteDialogOpenChange = useCallback((open: boolean) => {
    setShowDeleteDialog(open)
    if (!open) setDeletePromptId(null)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (deletePromptId) {
      confirmDeletePrompt(deletePromptId)
    }
    setShowDeleteDialog(false)
    setDeletePromptId(null)
  }, [deletePromptId, confirmDeletePrompt])

  const handleCancelDelete = useCallback(() => {
    setShowDeleteDialog(false)
    setDeletePromptId(null)
  }, [])

  return (
    <div className="space-y-8">
      <div className="h-[600px] border rounded-lg">
        <ReactFlowProvider>
          <Flow
            key={flowKey}
            assistantId={assistantId}
            prompts={prompts}
            models={models}
            onEdit={openEditDialog}
            onDelete={handleDeletePrompt}
            ref={reactFlowInstanceRef}
          />
        </ReactFlowProvider>
      </div>

      <Button onClick={handleAddButtonClick}>
        <PlusIcon className="h-4 w-4 mr-2" />
        Add Prompt
      </Button>

      {/* Add Prompt Modal */}
      <PromptEditorModal
        open={isAddDialogOpen}
        onOpenChange={handleAddDialogOpenChange}
        mode="add"
        promptName={form.promptName}
        setPromptName={form.setPromptName}
        promptContent={form.promptContent}
        setPromptContent={form.setPromptContent}
        systemContext={form.systemContext}
        setSystemContext={form.setSystemContext}
        modelId={form.modelId}
        setModelId={form.setModelId}
        enabledTools={form.enabledTools}
        setEnabledTools={form.setEnabledTools}
        useExternalKnowledge={form.useExternalKnowledge}
        setUseExternalKnowledge={form.setUseExternalKnowledge}
        selectedRepositoryIds={form.selectedRepositoryIds}
        setSelectedRepositoryIds={form.setSelectedRepositoryIds}
        models={models}
        inputFields={inputFields}
        prompts={prompts}
        editingPrompt={null}
        onSubmit={handleAddPrompt}
        isLoading={isLoading}
      />

      {/* Edit Prompt Modal */}
      <PromptEditorModal
        open={isEditDialogOpen}
        onOpenChange={handleEditDialogOpenChange}
        mode="edit"
        promptName={form.promptName}
        setPromptName={form.setPromptName}
        promptContent={form.promptContent}
        setPromptContent={form.setPromptContent}
        systemContext={form.systemContext}
        setSystemContext={form.setSystemContext}
        modelId={form.modelId}
        setModelId={form.setModelId}
        enabledTools={form.enabledTools}
        setEnabledTools={form.setEnabledTools}
        useExternalKnowledge={form.useExternalKnowledge}
        setUseExternalKnowledge={form.setUseExternalKnowledge}
        selectedRepositoryIds={form.selectedRepositoryIds}
        setSelectedRepositoryIds={form.setSelectedRepositoryIds}
        models={models}
        inputFields={inputFields}
        prompts={prompts}
        editingPrompt={form.editingPrompt}
        onSubmit={handleEditPrompt}
        isLoading={isLoading}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={handleDeleteDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this prompt? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
} 