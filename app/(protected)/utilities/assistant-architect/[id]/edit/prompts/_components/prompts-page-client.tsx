"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
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
// Dialog components removed - using Sheet instead
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { ModelSelectorFormAdapter } from "@/components/features/model-selector/model-selector-form-adapter"

import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { SelectAiModel, SelectChainPrompt, SelectToolInputField } from "@/types"
import React from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter
} from "@/components/ui/sheet"
import dynamic from "next/dynamic"
import {
  toolbarPlugin,
  markdownShortcutPlugin,
  listsPlugin,
  headingsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  Separator,
  CreateLink
} from "@mdxeditor/editor"
import DocumentUploadButton from "@/components/ui/document-upload-button"
import { RepositoryBrowser } from "@/components/features/assistant-architect/repository-browser"
import { ToolSelectionSection } from "@/components/features/assistant-architect/tool-selection-section"
const MDXEditor = dynamic(() => import("@mdxeditor/editor").then(mod => mod.MDXEditor), { ssr: false })




interface PromptsPageClientProps {
  assistantId: string
  prompts: SelectChainPrompt[]
  models: SelectAiModel[]
  inputFields: SelectToolInputField[]
}

interface KnowledgeSectionProps {
  useExternalKnowledge: boolean
  setUseExternalKnowledge: (value: boolean) => void
  systemContext: string
  setSystemContext: (value: string) => void
  selectedRepositoryIds: number[]
  setSelectedRepositoryIds: (ids: number[]) => void
  isPdfContentCollapsed: boolean
  setIsPdfContentCollapsed: (value: boolean) => void
  contextTokens: number
}

function KnowledgeSection({
  useExternalKnowledge,
  setUseExternalKnowledge,
  systemContext,
  setSystemContext,
  selectedRepositoryIds,
  setSelectedRepositoryIds,
  isPdfContentCollapsed,
  setIsPdfContentCollapsed,
  contextTokens
}: KnowledgeSectionProps) {
  const [isRepositoryBrowserOpen, setIsRepositoryBrowserOpen] = useState(false)
  
  return (
    <div className="space-y-4">
      {/* Toggle for external knowledge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            id="external-knowledge"
            checked={useExternalKnowledge}
            onCheckedChange={setUseExternalKnowledge}
          />
          <Label htmlFor="external-knowledge" className="cursor-pointer">
            Add external knowledge to your prompt
          </Label>
        </div>
      </div>

      {/* Show knowledge options when toggled on */}
      {useExternalKnowledge && (
        <div className="space-y-4 pl-4 border-l-2 border-muted">
          {/* Repository selector */}
          <div className="space-y-2">
            <Label>Knowledge Repositories</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsRepositoryBrowserOpen(true)}
              >
                Browse Repositories
              </Button>
              {selectedRepositoryIds.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {selectedRepositoryIds.length} selected
                </span>
              )}
            </div>
            {/* Display selected repositories as badges */}
            {selectedRepositoryIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedRepositoryIds.map(id => (
                  <Badge key={id} variant="secondary">
                    Repository {id}
                    <button
                      type="button"
                      onClick={() => setSelectedRepositoryIds(selectedRepositoryIds.filter(rid => rid !== id))}
                      className="ml-1 text-xs hover:text-destructive"
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* PDF upload and content section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Direct Knowledge Input</Label>
              <DocumentUploadButton 
                onContent={(doc: string) => {
                  const currentContext = systemContext || ""
                  const merged = (!currentContext || currentContext.trim() === "") ? doc : currentContext + "\n\n" + doc
                  setSystemContext(merged)
                  setIsPdfContentCollapsed(false)
                }}
                onError={err => {
                  if (err?.status === 413) {
                    toast.error("File too large. Please upload a file smaller than 50MB.")
                  } else {
                    toast.error("Upload failed: " + (err?.message || "Unknown error"))
                  }
                }}
              />
            </div>
            
            {/* Collapsible content area */}
            <Collapsible open={!isPdfContentCollapsed} onOpenChange={(open) => setIsPdfContentCollapsed(!(open ?? false))}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between p-2 h-auto"
                >
                  <span className="text-sm">
                    {systemContext ? "View/Edit content" : "Add custom content"}
                  </span>
                  <div className="flex items-center gap-2">
                    {systemContext && (
                      <span className="text-xs text-muted-foreground">{contextTokens} tokens</span>
                    )}
                    {isPdfContentCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="rounded-md border bg-muted h-[320px] overflow-y-auto mt-2">
                  <textarea
                    value={systemContext}
                    onChange={(e) => setSystemContext(e.target.value)}
                    placeholder="Enter system instructions, persona, or background knowledge for the AI model."
                    className="w-full h-full p-4 bg-[#e5e1d6] resize-none border-none outline-none font-mono text-sm"
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                  You can reference the knowledge in your prompt by saying things like &quot;Given the above context&quot; or &quot;Based on the provided information...&quot;
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      )}
      
      {/* Repository Browser Dialog */}
      <RepositoryBrowser
        open={isRepositoryBrowserOpen}
        onOpenChange={setIsRepositoryBrowserOpen}
        selectedIds={selectedRepositoryIds}
        onSelectionChange={setSelectedRepositoryIds}
      />
    </div>
  )
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

// Custom Node Component
function PromptNode({ data, id }: NodeProps) {
  // Type guard to ensure data has the expected properties
  const nodeData = data as unknown as PromptNodeData;
  
  const handleEdit = () => {
    if (nodeData.onEdit && nodeData.prompt) {
      nodeData.onEdit(nodeData.prompt)
    }
  }

  const handleDelete = () => {
    if (nodeData.onDelete && id) {
      nodeData.onDelete(id)
    }
  }

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

// Convert Flow to a forwardRef component
const Flow = React.forwardRef<FlowHandle, {
  assistantId: string,
  prompts: SelectChainPrompt[]
  models: SelectAiModel[]
  onEdit: (prompt: SelectChainPrompt) => void
  onDelete: (id: string) => void
}>(({ 
  assistantId,
  prompts, 
  models, 
  onEdit, 
  onDelete
}, ref) => {
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
    setNodes: (nodes: Node[]) => reactFlowInstance.setNodes(nodes),
    setEdges: (edges: Edge[]) => reactFlowInstance.setEdges(edges),
    savePositions: () => savePositions()
  }));

  // Calculate execution order based on graph structure
  const calculateExecutionOrder = useCallback((): { id: string; position: number }[] => {
    const nodes = reactFlowInstance.getNodes();
    const edges = reactFlowInstance.getEdges();
    const startNode = nodes.find(n => n.type === 'start');
    if (!startNode) return [];

    // Track nodes and their levels
    const nodeLevels = new Map<string, number>();
    const visited = new Set<string>();
    

    // Helper function to get outgoing edges from a node
    const getOutgoingEdges = (nodeId: string) =>
      edges.filter(e => e.source === nodeId);

    // First, calculate levels for all nodes using BFS
    const queue = [{ id: 'start', level: -1 }]; // Start node at level -1 so first real nodes are at 0
    while (queue.length > 0) {
      const { id, level } = queue.shift()!;
      
      if (visited.has(id)) {
        // If we've seen this node before, update its level to be the maximum
        nodeLevels.set(id, Math.max(level, nodeLevels.get(id) || 0));
        continue;
      }
      
      visited.add(id);
      nodeLevels.set(id, level);
      
      // Add all target nodes of outgoing edges to queue
      const outgoingEdges = getOutgoingEdges(id);
      for (const edge of outgoingEdges) {
        queue.push({ id: edge.target, level: level + 1 });
      }
    }

    // Build array of {id, position}
    const result = Array.from(nodeLevels.entries())
      .filter(([id]) => id !== 'start')
      .map(([id, level]) => ({ id, position: level }));


    return result;
  }, [reactFlowInstance]);

  // Save positions to database
  const savePositions = useCallback(async () => {
    setIsSaving(true);
    try {
      const order = calculateExecutionOrder();
      if (order.length === 0) { setIsSaving(false); return; }
      // Transaction update
      await setPromptPositionsAction(assistantId, order);
      toast.success("Graph structure saved");
    } catch { toast.error("Failed to save graph structure"); }
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
    
    // If no prompts, just set up the start node
    if (prompts.length === 0) {
      const startNode: Node = {
        id: 'start',
        type: 'start',
        position: { x: 250, y: 0 },
        data: {}
      }
      setNodes([startNode])
      setEdges([])
      initialPositionsSet.current = true
      return
    }

    // Create the prompt nodes with their initial positions
    const startNode: Node = {
      id: 'start',
      type: 'start',
      position: { x: 250, y: 0 },
      data: {}
    }

    // Group prompts by position to identify parallel execution paths
    const promptsByPosition = prompts.reduce((acc, prompt) => {
      const position = prompt.position || 0;
      if (!acc[position]) acc[position] = [];
      acc[position].push(prompt);
      return acc;
    }, {} as Record<number, SelectChainPrompt[]>);
    
    // Sort positions to ensure deterministic layout
    const positions = Object.keys(promptsByPosition).map(Number).sort((a, b) => a - b);
    
    // Create nodes with proper positioning based on execution paths
    const promptNodes: Node[] = [];
    const horizontalSpacing = 300;
    const verticalSpacing = 150;
    
    for (const [rowIndex, position] of positions.entries()) {
      const promptsAtPosition = promptsByPosition[position];
      const rowY = (rowIndex + 1) * verticalSpacing;
      
      // For parallel nodes (more than one at the same position)
      // arrange them horizontally
      for (const [colIndex, prompt] of promptsAtPosition.entries()) {
        const centerOffset = ((promptsAtPosition.length - 1) * horizontalSpacing) / 2;
        const xPos = 250 + (colIndex * horizontalSpacing) - centerOffset;
        
        promptNodes.push({
          id: String(prompt.id),
          type: 'prompt' as const,
          position: { x: xPos, y: rowY },
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
        });
      }
    }

    // Create edges based on positions and execution flow
    const newEdges: Edge[] = [];
    
    // First, connect start node to all position 0 prompts
    if (promptsByPosition[0]) {
      for (const prompt of promptsByPosition[0]) {
        newEdges.push({
          id: `e-start-${String(prompt.id)}`,
          source: 'start',
          target: String(prompt.id),
          type: 'smoothstep'
        });
      }
    }
    
    // Then connect each prompt to the next position's prompts
    for (let i = 0; i < positions.length - 1; i++) {
      const currentPosition = positions[i];
      const nextPosition = positions[i + 1];
      
      const currentPrompts = promptsByPosition[currentPosition];
      const nextPrompts = promptsByPosition[nextPosition];
      
      // If there's one prompt at current position and multiple at next position,
      // connect the current to each of the next (branching)
      if (currentPrompts.length === 1 && nextPrompts.length > 1) {
        const sourceId = String(currentPrompts[0].id);
        for (const targetPrompt of nextPrompts) {
          newEdges.push({
            id: `e-${sourceId}-${String(targetPrompt.id)}`,
            source: sourceId,
            target: String(targetPrompt.id),
            type: 'smoothstep'
          });
        }
      }
      // If there are multiple prompts at current position and one at next position,
      // connect each current to the next (merging)
      else if (currentPrompts.length > 1 && nextPrompts.length === 1) {
        const targetId = String(nextPrompts[0].id);
        for (const sourcePrompt of currentPrompts) {
          newEdges.push({
            id: `e-${String(sourcePrompt.id)}-${targetId}`,
            source: String(sourcePrompt.id),
            target: targetId,
            type: 'smoothstep'
          });
        }
      }
      // Otherwise, connect each current to each next
      else {
        // Default behavior: connect each node to all nodes in the next position
        // This is a simplification - you might want to improve this logic
        for (const sourcePrompt of currentPrompts) {
          for (const targetPrompt of nextPrompts) {
            newEdges.push({
              id: `e-${String(sourcePrompt.id)}-${String(targetPrompt.id)}`,
              source: String(sourcePrompt.id),
              target: String(targetPrompt.id),
              type: 'smoothstep'
            });
          }
        }
      }
    }

    
    setNodes([startNode, ...promptNodes])
    setEdges(newEdges)
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
});

Flow.displayName = 'Flow';

// Simple heuristic: 1 token ~ 4 characters (OpenAI guideline)
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// Add slugify utility at the top
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\da-z]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

// Custom Variable Insert Dropdown for MDXEditor toolbar
interface MDXEditorHandle {
  insertMarkdown: (text: string) => void;
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  focus: () => void;
}

function VariableInsertDropdown({ variables, editorRef }: { variables: string[], editorRef: React.RefObject<MDXEditorHandle | null> }) {
  return (
    <select
      className="border rounded px-2 py-1 text-xs bg-muted mr-2"
      defaultValue=""
      onChange={e => {
        const value = e.target.value;
        if (!value) return;
        if (editorRef.current && typeof editorRef.current.insertMarkdown === 'function') {
          editorRef.current.insertMarkdown(value);
        }
        e.target.value = "";
      }}
    >
      <option value="" disabled>
        Insert variable
      </option>
      {variables.map(v => (
        <option key={v} value={`$\u007B${v}\u007D`}>{`$\u007B${v}\u007D`}</option>
      ))}
    </select>
  );
}

export function PromptsPageClient({ assistantId, prompts: initialPrompts, models, inputFields }: PromptsPageClientProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [promptName, setPromptName] = useState("")
  const [promptContent, setPromptContent] = useState("")
  const [systemContext, setSystemContext] = useState("")
  const [modelId, setModelId] = useState<string | null>(null)
  const [editingPrompt, setEditingPrompt] = useState<SelectChainPrompt | null>(null)
  const [prompts, setPrompts] = useState<SelectChainPrompt[]>(initialPrompts)
  const reactFlowInstanceRef = useRef<FlowHandle>(null);
  const [contextTokens, setContextTokens] = useState(0)
  const [useExternalKnowledge, setUseExternalKnowledge] = useState(false)
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>([])
  const [isPdfContentCollapsed, setIsPdfContentCollapsed] = useState(true)
  const [promptTokens, setPromptTokens] = useState(0)
  const [flowKey, setFlowKey] = useState(0)
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const mdxEditorRef = useRef<MDXEditorHandle>(null);

  // When initialPrompts changes (from server), update our local state
  useEffect(() => {
    setPrompts(initialPrompts);
  }, [initialPrompts]);

  useEffect(() => {
    setContextTokens(estimateTokens(systemContext))
  }, [systemContext])

  useEffect(() => {
    setPromptTokens(estimateTokens(promptContent))
  }, [promptContent])

  const handleAddPrompt = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      if (!modelId) {
        toast.error("You must select a model for the prompt.");
        setIsLoading(false);
        return;
      }
      // Create the new prompt
      const result = await addChainPromptAction(
        assistantId,
        {
          name: promptName,
          content: promptContent,
          systemContext: systemContext || undefined,
          modelId: Number.parseInt(modelId as string),
          position: typeof prompts.length === 'number' ? prompts.length : 0,
          repositoryIds: useExternalKnowledge ? selectedRepositoryIds : [],
          enabledTools: enabledTools,
        }
      )

      if (result.isSuccess) {
        toast.success("Prompt added successfully")
        setIsAddDialogOpen(false)
        setPromptName("")
        setPromptContent("")
        setSystemContext("")
        setModelId(null)
        setUseExternalKnowledge(false)
        setSelectedRepositoryIds([])
        setIsPdfContentCollapsed(true)
        setEnabledTools([])
        
        // Get the updated prompts
        const updatedResult = await getAssistantArchitectByIdAction(assistantId);
        if (updatedResult.isSuccess && updatedResult.data?.prompts) {
          setPrompts(updatedResult.data.prompts as SelectChainPrompt[]);
          setFlowKey(k => k + 1); // Force Flow remount
        }
      } else {
        toast.error(result.message)
      }
    } catch {
      toast.error("Failed to add prompt")
    } finally {
      setIsLoading(false)
    }
  }

  const handleEditPrompt = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingPrompt) return
    
    setIsLoading(true)

    try {
      if (!modelId) {
        toast.error("You must select a model for the prompt.");
        setIsLoading(false);
        return;
      }
      const updateData = {
        name: promptName,
        content: promptContent,
        systemContext: systemContext || undefined,
        modelId: Number.parseInt(modelId),
        repositoryIds: useExternalKnowledge && selectedRepositoryIds.length > 0
          ? selectedRepositoryIds.filter(id => id !== undefined && id !== null)
          : [], // Send empty array to clear repositories, not undefined
        enabledTools: enabledTools,
      };
      
      const result = await updatePromptAction(editingPrompt.id.toString(), updateData)

      if (result.isSuccess) {
        toast.success("Prompt updated successfully")
        setIsEditDialogOpen(false)
        setEditingPrompt(null)
        
        // Update the prompts in our local state
        setPrompts(currentPrompts =>
          currentPrompts.map(p =>
            p.id === editingPrompt.id && result.data ? (result.data as SelectChainPrompt) : p
          )
        )
        setFlowKey(k => k + 1); // Force Flow remount
      } else {
        toast.error(result.message)
      }
    } catch {
      toast.error("Failed to update prompt")
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeletePrompt = async (promptId: string) => {
    if (!window.confirm("Are you sure you want to delete this prompt?")) {
      return;
    }
    
    try {
      // Use the string ID directly for the API call
      const result = await deletePromptAction(promptId)

      if (result.isSuccess) {
        toast.success("Prompt deleted successfully")
        
        // Remove the deleted prompt from our local state
        const promptIdInt = Number.parseInt(promptId, 10);
        setPrompts(current => current.filter(p => p.id !== promptIdInt))
        
        // Update the graph with the latest execution order
        if (reactFlowInstanceRef.current) {
          const graphInstance = reactFlowInstanceRef.current;
          setTimeout(() => {
            // Remove the node
            const updatedNodes = graphInstance.getNodes().filter(n => n.id !== promptId);
            graphInstance.setNodes(updatedNodes);
            
            // Remove edges connected to this node
            const updatedEdges = graphInstance.getEdges().filter(
              e => e.source !== promptId && e.target !== promptId
            );
            graphInstance.setEdges(updatedEdges);
            
            // Save the new structure
            const savePositionsFunc = reactFlowInstanceRef.current?.savePositions;
            if (typeof savePositionsFunc === 'function') {
              setTimeout(savePositionsFunc, 100);
            }
          }, 100);
        }
      } else {
        toast.error(result.message)
      }
    } catch {
      toast.error("Failed to delete prompt")
    }
  }

  const openEditDialog = async (prompt: SelectChainPrompt) => {
    setIsLoading(true)
    try {
      const result = await getAssistantArchitectByIdAction(assistantId)
      let latestPrompt = prompt
      if (result.isSuccess && result.data?.prompts) {
        const found = result.data.prompts.find((p: SelectChainPrompt) => p.id === prompt.id)
        if (found) latestPrompt = found
      }
      setEditingPrompt(latestPrompt)
      setPromptName(latestPrompt.name)
      setPromptContent(latestPrompt.content)
      setSystemContext(latestPrompt.systemContext || "")
      setModelId(latestPrompt.modelId ? latestPrompt.modelId.toString() : null)
      setUseExternalKnowledge(Boolean(latestPrompt.repositoryIds && latestPrompt.repositoryIds.length > 0))
      setSelectedRepositoryIds(latestPrompt.repositoryIds || [])
      setEnabledTools(latestPrompt.enabledTools || [])
      setIsPdfContentCollapsed(true)
      setIsEditDialogOpen(true)
    } catch {
      toast.error("Failed to fetch latest prompt data")
      setIsEditDialogOpen(true)
    } finally {
      setIsLoading(false)
    }
  }


  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
          </div>
        </div>
      </div>

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

      <Button onClick={() => {
        setPromptName("");
        setPromptContent("");
        setSystemContext("");
        setModelId(null);
        setUseExternalKnowledge(false);
        setSelectedRepositoryIds([]);
        setEnabledTools([]);
        setIsPdfContentCollapsed(true);
        setIsAddDialogOpen(true);
      }}>
        <PlusIcon className="h-4 w-4 mr-2" />
        Add Prompt
      </Button>
      <Sheet open={isAddDialogOpen} onOpenChange={open => { if (!open) setIsAddDialogOpen(false) }}>
        <SheetContent
          position="right"
          size="content"
          className="w-[60vw] max-w-none h-screen p-0 flex flex-col"
          onInteractOutside={e => e.preventDefault()} // Prevent closing by clicking outside
          onEscapeKeyDown={e => e.preventDefault()} // Prevent closing by escape
        >
          <form onSubmit={handleAddPrompt} className="flex flex-col h-full">
            <SheetHeader className="p-6 pb-0">
              <SheetTitle>Add Prompt</SheetTitle>
              <SheetDescription>
                Create a new prompt for your Assistant Architect.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-6 pt-2 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Prompt Name</Label>
                <Input
                  id="name"
                  value={promptName}
                  onChange={(e) => setPromptName(e.target.value)}
                  placeholder="Enter a prompt name"
                  required
                  className="bg-muted"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="model">AI Model</Label>
                <ModelSelectorFormAdapter
                  models={models}
                  value={modelId}
                  onValueChange={setModelId}
                  placeholder="Select an AI model"
                  className="bg-muted"
                  requiredCapabilities={["chat"]}
                  hideRoleRestricted={true}
                  hideCapabilityMissing={true}
                />
              </div>
              <ToolSelectionSection
                selectedModelId={modelId && !Number.isNaN(Number.parseInt(modelId)) ? Number.parseInt(modelId) : null}
                enabledTools={enabledTools}
                onToolsChange={setEnabledTools}
                models={models}
                disabled={isLoading}
              />
              <KnowledgeSection
                useExternalKnowledge={useExternalKnowledge}
                setUseExternalKnowledge={setUseExternalKnowledge}
                systemContext={systemContext}
                setSystemContext={setSystemContext}
                selectedRepositoryIds={selectedRepositoryIds}
                setSelectedRepositoryIds={setSelectedRepositoryIds}
                isPdfContentCollapsed={isPdfContentCollapsed}
                setIsPdfContentCollapsed={setIsPdfContentCollapsed}
                contextTokens={contextTokens}
              />
              <div className="space-y-2">
                <Label htmlFor="content">Prompt Content</Label>
                <div className="rounded-md border bg-muted h-[320px] overflow-y-auto">
                  <MDXEditor
                    ref={mdxEditorRef}
                    markdown={promptContent}
                    onChange={v => setPromptContent(v ?? "")}
                    className="min-h-full bg-[#e5e1d6]"
                    contentEditableClassName="prose"
                    placeholder="Enter your prompt content. Use ${variableName} for dynamic values."
                    plugins={[
                      toolbarPlugin({
                        toolbarContents: () => (
                          <>
                            <VariableInsertDropdown
                              variables={[
                                ...inputFields.map(f => f.name),
                                ...prompts
                                  .filter((p, idx) => !editingPrompt ? true : prompts.findIndex(pp => pp.id === editingPrompt.id) > idx)
                                  .map(prevPrompt => slugify(prevPrompt.name))
                              ]}
                              editorRef={mdxEditorRef}
                            />
                            <UndoRedo />
                            <Separator />
                            <BoldItalicUnderlineToggles />
                            <Separator />
                            <BlockTypeSelect />
                            <Separator />
                            <ListsToggle />
                            <Separator />
                            <CreateLink />
                          </>
                        )
                      }),
                      markdownShortcutPlugin(),
                      listsPlugin(),
                      headingsPlugin(),
                      quotePlugin(),
                      thematicBreakPlugin(),
                      linkPlugin(),
                      linkDialogPlugin()
                    ]}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {promptTokens} tokens
                </div>
              </div>
              <div className="space-y-2">
                <Label>Available Variables</Label>
                <div className="flex flex-wrap gap-2">
                  {inputFields.map(field => (
                    <span key={field.id} className="px-2 py-1 rounded bg-muted text-xs font-mono border">
                      {field.name}
                    </span>
                  ))}
                  {/* Show previous prompt names (slugified) */}
                  {prompts
                    .filter((p, idx) => !editingPrompt ? true : prompts.findIndex(pp => pp.id === editingPrompt.id) > idx)
                    .map(prevPrompt => (
                      <span key={prevPrompt.id} className="px-2 py-1 rounded bg-muted text-xs font-mono border">
                        {slugify(prevPrompt.name)}
                      </span>
                    ))}
                </div>
                <div className="text-sm text-muted-foreground mt-2">
                  Use these variables in your prompt with $&#123;variableName&#125;
                </div>
              </div>
            </div>
            <SheetFooter className="p-6 pt-4 bg-[#f6f5ee] border-t flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddDialogOpen(false)}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Adding..." : "Add Prompt"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {editingPrompt && (
        <Sheet open={isEditDialogOpen} onOpenChange={open => { if (!open) setIsEditDialogOpen(false) }}>
          <SheetContent
            position="right"
            size="content"
            className="w-[60vw] max-w-none h-screen p-0 flex flex-col"
            onInteractOutside={e => e.preventDefault()} // Prevent closing by clicking outside
            onEscapeKeyDown={e => e.preventDefault()} // Prevent closing by escape
          >
            <form onSubmit={handleEditPrompt} className="flex flex-col h-full">
              <SheetHeader className="p-6 pb-0">
                <SheetTitle>Edit Prompt</SheetTitle>
                <SheetDescription>Update the prompt configuration.</SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto p-6 pt-2 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-name">Prompt Name</Label>
                  <Input
                    id="edit-name"
                    value={promptName}
                    onChange={(e) => setPromptName(e.target.value)}
                    placeholder="Enter a prompt name"
                    required
                    className="bg-muted"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-model">AI Model</Label>
                  <ModelSelectorFormAdapter
                    models={models}
                    value={modelId}
                    onValueChange={setModelId}
                    placeholder="Select an AI model"
                    className="bg-muted"
                    requiredCapabilities={["chat"]}
                    hideRoleRestricted={true}
                    hideCapabilityMissing={true}
                  />
                </div>
                <ToolSelectionSection
                  selectedModelId={modelId && !Number.isNaN(Number.parseInt(modelId)) ? Number.parseInt(modelId) : null}
                  enabledTools={enabledTools}
                  onToolsChange={setEnabledTools}
                  models={models}
                  disabled={isLoading}
                />
                <KnowledgeSection
                  useExternalKnowledge={useExternalKnowledge}
                  setUseExternalKnowledge={setUseExternalKnowledge}
                  systemContext={systemContext}
                  setSystemContext={setSystemContext}
                  selectedRepositoryIds={selectedRepositoryIds}
                  setSelectedRepositoryIds={setSelectedRepositoryIds}
                  isPdfContentCollapsed={isPdfContentCollapsed}
                  setIsPdfContentCollapsed={setIsPdfContentCollapsed}
                  contextTokens={contextTokens}
                />
                <div className="space-y-2">
                  <Label htmlFor="edit-content">Prompt Content</Label>
                  <div className="rounded-md border bg-muted h-[320px] overflow-y-auto">
                    <MDXEditor
                      ref={mdxEditorRef}
                      markdown={promptContent}
                      onChange={v => setPromptContent(v ?? "")}
                      className="min-h-full bg-[#e5e1d6]"
                      contentEditableClassName="prose"
                      placeholder="Enter your prompt content. Use ${variableName} for dynamic values."
                      plugins={[
                        toolbarPlugin({
                          toolbarContents: () => (
                            <>
                              <VariableInsertDropdown
                                variables={[
                                  ...inputFields.map(f => f.name),
                                  ...prompts
                                    .filter((p, idx) => !editingPrompt ? true : prompts.findIndex(pp => pp.id === editingPrompt.id) > idx)
                                    .map(prevPrompt => slugify(prevPrompt.name))
                                ]}
                                editorRef={mdxEditorRef}
                              />
                              <UndoRedo />
                              <Separator />
                              <BoldItalicUnderlineToggles />
                              <Separator />
                              <BlockTypeSelect />
                              <Separator />
                              <ListsToggle />
                              <Separator />
                              <CreateLink />
                            </>
                          )
                        }),
                        markdownShortcutPlugin(),
                        listsPlugin(),
                        headingsPlugin(),
                        quotePlugin(),
                        thematicBreakPlugin(),
                        linkPlugin(),
                        linkDialogPlugin()
                      ]}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {promptTokens} tokens
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Available Variables</Label>
                  <div className="flex flex-wrap gap-2">
                    {inputFields.map(field => (
                      <span key={field.id} className="px-2 py-1 rounded bg-muted text-xs font-mono border">
                        {field.name}
                      </span>
                    ))}
                    {/* Show previous prompt names (slugified) */}
                    {prompts
                      .filter((p, idx) => !editingPrompt ? true : prompts.findIndex(pp => pp.id === editingPrompt.id) > idx)
                      .map(prevPrompt => (
                        <span key={prevPrompt.id} className="px-2 py-1 rounded bg-muted text-xs font-mono border">
                          {slugify(prevPrompt.name)}
                        </span>
                      ))}
                  </div>
                  <div className="text-sm text-muted-foreground mt-2">
                    Use these variables in your prompt with $&#123;variableName&#125;
                  </div>
                </div>
              </div>
              <SheetFooter className="p-6 pt-4 bg-[#f6f5ee] border-t flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditDialogOpen(false)}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoading} onClick={() => {}}>
                  {isLoading ? "Saving..." : "Save Changes"}
                </Button>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
} 