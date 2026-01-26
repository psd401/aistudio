"use client"

import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { XIcon, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import { ModelSelectorFormAdapter } from "@/components/features/model-selector/model-selector-form-adapter"
import { ToolSelectionSection } from "@/components/features/assistant-architect/tool-selection-section"
import { RepositoryBrowser } from "@/components/features/assistant-architect/repository-browser"
import DocumentUploadButton from "@/components/ui/document-upload-button"
import { toast } from "sonner"
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
  Separator as MDXSeparator,
  CreateLink,
  type MDXEditorMethods
} from "@mdxeditor/editor"
import type { SelectAiModel, SelectChainPrompt, SelectToolInputField } from "@/types"

// Dynamic import MDXEditor to avoid SSR issues
const MDXEditor = dynamic(() => import("@mdxeditor/editor").then(mod => mod.MDXEditor), { ssr: false })

// Token estimation: ~4 characters per token (OpenAI guideline)
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// Slugify utility for variable names
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\da-z]+/g, '-')
    .replace(/(^-|-$)+/g, '')
}

interface PromptEditorModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "add" | "edit"
  // Form data
  promptName: string
  setPromptName: (value: string) => void
  promptContent: string
  setPromptContent: (value: string) => void
  systemContext: string
  setSystemContext: (value: string) => void
  modelId: string | null
  setModelId: (value: string | null) => void
  enabledTools: string[]
  setEnabledTools: (tools: string[]) => void
  useExternalKnowledge: boolean
  setUseExternalKnowledge: (value: boolean) => void
  selectedRepositoryIds: number[]
  setSelectedRepositoryIds: (ids: number[]) => void
  // Reference data
  models: SelectAiModel[]
  inputFields: SelectToolInputField[]
  prompts: SelectChainPrompt[]
  editingPrompt: SelectChainPrompt | null
  // Actions
  onSubmit: (e: React.FormEvent) => Promise<void>
  isLoading: boolean
}

// Click-to-insert variable badge component
function VariableBadge({
  name,
  onInsert
}: {
  name: string
  onInsert: (variable: string) => void
}) {
  const handleClick = useCallback(() => {
    onInsert(`\${${name}}`)
  }, [name, onInsert])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onInsert(`\${${name}}`)
    }
  }, [name, onInsert])

  return (
    <Badge
      variant="outline"
      className="cursor-pointer hover:bg-accent hover:border-primary transition-colors text-sm px-3 py-1.5 font-mono min-h-[36px] flex items-center"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`Insert variable ${name} into prompt`}
    >
      {`\${${name}}`}
    </Badge>
  )
}

// Token count badge with warning states
function TokenCountBadge({ tokens, maxTokens }: { tokens: number; maxTokens?: number | null }) {
  const percentage = maxTokens ? (tokens / maxTokens) * 100 : 0

  let variant: "secondary" | "outline" | "destructive" = "secondary"
  if (percentage > 90) {
    variant = "destructive"
  } else if (percentage > 75) {
    variant = "outline"
  }

  return (
    <Badge variant={variant} className="text-xs font-mono tabular-nums">
      {tokens.toLocaleString()} tokens
      {maxTokens && percentage > 75 && (
        <span className="ml-1">({Math.round(percentage)}%)</span>
      )}
    </Badge>
  )
}

// Repository badge item component for proper callback handling
function RepositoryBadgeItem({
  id,
  onRemove
}: {
  id: number
  onRemove: (id: number) => void
}) {
  const handleRemove = useCallback(() => {
    onRemove(id)
  }, [id, onRemove])

  return (
    <Badge variant="secondary">
      Repository {id}
      <button
        type="button"
        onClick={handleRemove}
        className="ml-1 text-xs hover:text-destructive"
      >
        ×
      </button>
    </Badge>
  )
}

// Knowledge section component
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
}: {
  useExternalKnowledge: boolean
  setUseExternalKnowledge: (value: boolean) => void
  systemContext: string
  setSystemContext: (value: string) => void
  selectedRepositoryIds: number[]
  setSelectedRepositoryIds: (ids: number[]) => void
  isPdfContentCollapsed: boolean
  setIsPdfContentCollapsed: (value: boolean) => void
  contextTokens: number
}) {
  const [isRepositoryBrowserOpen, setIsRepositoryBrowserOpen] = useState(false)

  const handleOpenRepositoryBrowser = useCallback(() => {
    setIsRepositoryBrowserOpen(true)
  }, [])

  const handleRemoveRepository = useCallback((idToRemove: number) => {
    setSelectedRepositoryIds(selectedRepositoryIds.filter(rid => rid !== idToRemove))
  }, [selectedRepositoryIds, setSelectedRepositoryIds])

  const handleDocumentContent = useCallback((doc: string) => {
    const currentContext = systemContext || ""
    const merged = (!currentContext || currentContext.trim() === "") ? doc : currentContext + "\n\n" + doc
    setSystemContext(merged)
    setIsPdfContentCollapsed(false)
  }, [systemContext, setSystemContext, setIsPdfContentCollapsed])

  const handleDocumentError = useCallback((err: { status?: number; message?: string } | null) => {
    if (err?.status === 413) {
      toast.error("File too large. Please upload a file smaller than 50MB.")
    } else {
      toast.error("Upload failed: " + (err?.message || "Unknown error"))
    }
  }, [])

  const handleCollapsibleOpenChange = useCallback((open: boolean | undefined) => {
    setIsPdfContentCollapsed(!(open ?? false))
  }, [setIsPdfContentCollapsed])

  const handleSystemContextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSystemContext(e.target.value)
  }, [setSystemContext])

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
          <Label htmlFor="external-knowledge" className="cursor-pointer text-sm">
            Add external knowledge
          </Label>
        </div>
      </div>

      {/* Show knowledge options when toggled on */}
      {useExternalKnowledge && (
        <div className="space-y-4 pl-4 border-l-2 border-muted">
          {/* Repository selector */}
          <div className="space-y-2">
            <Label className="text-sm">Knowledge Repositories</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOpenRepositoryBrowser}
              >
                Browse Repositories
              </Button>
              {selectedRepositoryIds.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {selectedRepositoryIds.length} selected
                </span>
              )}
            </div>
            {selectedRepositoryIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedRepositoryIds.map(id => (
                  <RepositoryBadgeItem
                    key={id}
                    id={id}
                    onRemove={handleRemoveRepository}
                  />
                ))}
              </div>
            )}
          </div>

          {/* PDF upload and content section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Direct Knowledge Input</Label>
              <DocumentUploadButton
                onContent={handleDocumentContent}
                onError={handleDocumentError}
              />
            </div>

            <Collapsible open={!isPdfContentCollapsed} onOpenChange={handleCollapsibleOpenChange}>
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
                <div className="rounded-md border bg-muted h-[200px] overflow-y-auto mt-2">
                  <textarea
                    value={systemContext}
                    onChange={handleSystemContextChange}
                    placeholder="Enter system instructions, persona, or background knowledge for the AI model."
                    className="w-full h-full p-4 bg-muted resize-none border-none outline-none font-mono text-sm"
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      )}

      {/* Repository Browser Dialog - Higher z-index for nesting */}
      <RepositoryBrowser
        open={isRepositoryBrowserOpen}
        onOpenChange={setIsRepositoryBrowserOpen}
        selectedIds={selectedRepositoryIds}
        onSelectionChange={setSelectedRepositoryIds}
      />
    </div>
  )
}

// Constant for required capabilities to avoid recreating array
const CHAT_CAPABILITIES: string[] = ["chat"]

// Custom hook for tracking unsaved changes
interface UnsavedChangesState {
  promptName: string
  promptContent: string
  systemContext: string
  modelId: string | null
  enabledTools: string[]
  useExternalKnowledge: boolean
  selectedRepositoryIds: number[]
}

function useUnsavedChanges(
  open: boolean,
  currentState: UnsavedChangesState
): boolean {
  const initialValuesRef = useRef<UnsavedChangesState>({
    promptName: '',
    promptContent: '',
    systemContext: '',
    modelId: null,
    enabledTools: [],
    useExternalKnowledge: false,
    selectedRepositoryIds: []
  })

  // Capture initial values when modal opens
  useEffect(() => {
    if (open) {
      initialValuesRef.current = {
        ...currentState,
        enabledTools: [...currentState.enabledTools],
        selectedRepositoryIds: [...currentState.selectedRepositoryIds]
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return useMemo(() => {
    const initial = initialValuesRef.current
    // Check array equality (order-independent)
    const toolsChanged = currentState.enabledTools.length !== initial.enabledTools.length ||
      !currentState.enabledTools.every(t => initial.enabledTools.includes(t))
    const repoIdsChanged = currentState.selectedRepositoryIds.length !== initial.selectedRepositoryIds.length ||
      !currentState.selectedRepositoryIds.every(id => initial.selectedRepositoryIds.includes(id))

    return (
      currentState.promptName !== initial.promptName ||
      currentState.promptContent !== initial.promptContent ||
      currentState.systemContext !== initial.systemContext ||
      currentState.modelId !== initial.modelId ||
      toolsChanged ||
      currentState.useExternalKnowledge !== initial.useExternalKnowledge ||
      repoIdsChanged
    )
  }, [currentState])
}

// Constant dialog content style to avoid recreation
const DIALOG_CONTENT_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(95vw, 1600px)',
  maxWidth: 'min(95vw, 1600px)',
  minWidth: 'min(90vw, 800px)',
  height: '90vh',
  maxHeight: '90vh',
  zIndex: 50,
}

// Settings column component - extracted to reduce main component line count
interface SettingsColumnProps {
  promptName: string
  setPromptName: (value: string) => void
  modelId: string | null
  setModelId: (value: string | null) => void
  enabledTools: string[]
  setEnabledTools: (tools: string[]) => void
  useExternalKnowledge: boolean
  setUseExternalKnowledge: (value: boolean) => void
  systemContext: string
  setSystemContext: (value: string) => void
  selectedRepositoryIds: number[]
  setSelectedRepositoryIds: (ids: number[]) => void
  isPdfContentCollapsed: boolean
  setIsPdfContentCollapsed: (value: boolean) => void
  contextTokens: number
  availableVariables: string[]
  handleInsertVariable: (variable: string) => void
  models: SelectAiModel[]
  isLoading: boolean
}

function SettingsColumn({
  promptName,
  setPromptName,
  modelId,
  setModelId,
  enabledTools,
  setEnabledTools,
  useExternalKnowledge,
  setUseExternalKnowledge,
  systemContext,
  setSystemContext,
  selectedRepositoryIds,
  setSelectedRepositoryIds,
  isPdfContentCollapsed,
  setIsPdfContentCollapsed,
  contextTokens,
  availableVariables,
  handleInsertVariable,
  models,
  isLoading
}: SettingsColumnProps) {
  const handlePromptNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPromptName(e.target.value)
  }, [setPromptName])

  // Parse model ID once to avoid double parsing
  const parsedModelId = useMemo(() => {
    if (!modelId) return null
    const parsed = Number.parseInt(modelId, 10)
    return Number.isNaN(parsed) ? null : parsed
  }, [modelId])

  return (
    <div className="flex flex-col gap-4 overflow-y-auto lg:border-r lg:pr-6">
      {/* Section: Basic Info */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Basic Info</h3>
        <div className="space-y-2">
          <Label htmlFor="prompt-name">Prompt Name *</Label>
          <Input
            id="prompt-name"
            value={promptName}
            onChange={handlePromptNameChange}
            placeholder="Enter a prompt name"
            required
            className="bg-muted"
          />
        </div>
      </section>

      <Separator />

      {/* Section: Model & Capabilities */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Model & Capabilities</h3>
        <div className="space-y-2">
          <Label htmlFor="model">AI Model *</Label>
          <ModelSelectorFormAdapter
            models={models}
            value={modelId}
            onValueChange={setModelId}
            placeholder="Select an AI model"
            className="bg-muted"
            requiredCapabilities={CHAT_CAPABILITIES}
            hideRoleRestricted={true}
            hideCapabilityMissing={true}
          />
        </div>
        <ToolSelectionSection
          selectedModelId={parsedModelId}
          enabledTools={enabledTools}
          onToolsChange={setEnabledTools}
          models={models}
          disabled={isLoading}
        />
      </section>

      <Separator />

      {/* Section: Knowledge & Context */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Knowledge & Context</h3>
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
      </section>

      <Separator />

      {/* Section: Available Variables - Sticky on desktop */}
      <section className="space-y-3 lg:sticky lg:bottom-0 lg:bg-background lg:py-4 lg:-mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Available Variables</h3>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs text-sm">
                  Click any variable to insert it at the cursor position in your prompt.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-xs text-muted-foreground">Click to insert:</p>
        <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
          {availableVariables.length > 0 ? (
            availableVariables.map(variable => (
              <VariableBadge
                key={variable}
                name={variable}
                onInsert={handleInsertVariable}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No variables available. Add input fields to your assistant to create variables.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

// Dialog header component - extracted to reduce main component line count
interface DialogHeaderProps {
  mode: "add" | "edit"
}

function DialogHeader({ mode }: DialogHeaderProps) {
  const title = mode === "add" ? "Add Prompt" : "Edit Prompt"

  return (
    <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b">
      <div className="flex items-center justify-between">
        <div>
          <Dialog.Title className="text-xl font-semibold leading-none">{title}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground mt-1">
            {mode === "add"
              ? "Create a new prompt step for your Assistant Architect."
              : "Update the prompt configuration."}
          </Dialog.Description>
        </div>
        <Dialog.Close className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <XIcon className="h-5 w-5" />
          <span className="sr-only">Close</span>
        </Dialog.Close>
      </div>
    </div>
  )
}

// Dialog footer component - extracted to reduce main component line count
interface DialogFooterProps {
  mode: "add" | "edit"
  isLoading: boolean
  hasUnsavedChanges: boolean
  onCancel: () => void
}

function DialogFooter({ mode, isLoading, hasUnsavedChanges, onCancel }: DialogFooterProps) {
  return (
    <div className="flex-shrink-0 flex items-center justify-between border-t px-6 py-4 bg-muted/30">
      <div className="text-xs text-muted-foreground">
        {hasUnsavedChanges && "You have unsaved changes"}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading}>
          {isLoading
            ? (mode === "add" ? "Adding..." : "Saving...")
            : (mode === "add" ? "Add Prompt" : "Save Changes")}
        </Button>
      </div>
    </div>
  )
}

// Main content area component - two column layout
interface MainContentAreaProps {
  promptName: string
  setPromptName: (value: string) => void
  modelId: string | null
  setModelId: (value: string | null) => void
  enabledTools: string[]
  setEnabledTools: (tools: string[]) => void
  useExternalKnowledge: boolean
  setUseExternalKnowledge: (value: boolean) => void
  systemContext: string
  setSystemContext: (value: string) => void
  selectedRepositoryIds: number[]
  setSelectedRepositoryIds: (ids: number[]) => void
  isPdfContentCollapsed: boolean
  setIsPdfContentCollapsed: (value: boolean) => void
  contextTokens: number
  availableVariables: string[]
  handleInsertVariable: (variable: string) => void
  models: SelectAiModel[]
  isLoading: boolean
  promptContent: string
  setPromptContent: (value: string) => void
  promptTokens: number
  maxTokens?: number | null
  mdxEditorRef: React.RefObject<MDXEditorMethods | null>
}

function MainContentArea({
  promptName,
  setPromptName,
  modelId,
  setModelId,
  enabledTools,
  setEnabledTools,
  useExternalKnowledge,
  setUseExternalKnowledge,
  systemContext,
  setSystemContext,
  selectedRepositoryIds,
  setSelectedRepositoryIds,
  isPdfContentCollapsed,
  setIsPdfContentCollapsed,
  contextTokens,
  availableVariables,
  handleInsertVariable,
  models,
  isLoading,
  promptContent,
  setPromptContent,
  promptTokens,
  maxTokens,
  mdxEditorRef
}: MainContentAreaProps) {
  return (
    <div className="flex-1 overflow-hidden px-6 py-4">
      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6 h-full">
        <SettingsColumn
          promptName={promptName}
          setPromptName={setPromptName}
          modelId={modelId}
          setModelId={setModelId}
          enabledTools={enabledTools}
          setEnabledTools={setEnabledTools}
          useExternalKnowledge={useExternalKnowledge}
          setUseExternalKnowledge={setUseExternalKnowledge}
          systemContext={systemContext}
          setSystemContext={setSystemContext}
          selectedRepositoryIds={selectedRepositoryIds}
          setSelectedRepositoryIds={setSelectedRepositoryIds}
          isPdfContentCollapsed={isPdfContentCollapsed}
          setIsPdfContentCollapsed={setIsPdfContentCollapsed}
          contextTokens={contextTokens}
          availableVariables={availableVariables}
          handleInsertVariable={handleInsertVariable}
          models={models}
          isLoading={isLoading}
        />
        <EditorColumn
          promptContent={promptContent}
          setPromptContent={setPromptContent}
          promptTokens={promptTokens}
          maxTokens={maxTokens}
          mdxEditorRef={mdxEditorRef}
        />
      </div>
    </div>
  )
}

// Custom hook for keyboard shortcut (Cmd/Ctrl+S to save)
function useKeyboardShortcut(open: boolean, formRef: React.RefObject<HTMLFormElement | null>) {
  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        formRef.current?.requestSubmit()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, formRef])
}

// Unsaved changes confirmation dialog - extracted to reduce main component line count
interface UnsavedChangesDialogProps {
  open: boolean
  onContinueEditing: () => void
  onDiscardChanges: () => void
}

function UnsavedChangesDialog({
  open,
  onContinueEditing,
  onDiscardChanges
}: UnsavedChangesDialogProps) {
  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) onContinueEditing()
  }, [onContinueEditing])

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="z-[100]">
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes. Are you sure you want to close without saving?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onContinueEditing}>
            Continue Editing
          </AlertDialogCancel>
          <AlertDialogAction onClick={onDiscardChanges}>
            Discard Changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// Editor column component - extracted to reduce main component line count
interface EditorColumnProps {
  promptContent: string
  setPromptContent: (value: string) => void
  promptTokens: number
  maxTokens?: number | null
  mdxEditorRef: React.RefObject<MDXEditorMethods | null>
}

function EditorColumn({
  promptContent,
  setPromptContent,
  promptTokens,
  maxTokens,
  mdxEditorRef
}: EditorColumnProps) {
  const handleContentChange = useCallback((v: string | undefined) => {
    setPromptContent(v ?? "")
  }, [setPromptContent])

  const editorPlugins = useMemo(() => [
    toolbarPlugin({
      toolbarContents: () => (
        <>
          <UndoRedo />
          <MDXSeparator />
          <BoldItalicUnderlineToggles />
          <MDXSeparator />
          <BlockTypeSelect />
          <MDXSeparator />
          <ListsToggle />
          <MDXSeparator />
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
  ], [])

  return (
    <div className="flex flex-col h-full min-h-[400px] lg:min-h-0 overflow-hidden">
      <div className="flex items-center justify-between mb-2 px-1">
        <Label htmlFor="content" className="text-sm font-medium">Prompt Content</Label>
        <div className="flex items-center gap-2">
          <TokenCountBadge
            tokens={promptTokens}
            maxTokens={maxTokens}
          />
          <span className="text-xs text-muted-foreground">Markdown supported</span>
        </div>
      </div>
      <div className="flex-1 rounded-md border bg-muted overflow-hidden flex flex-col">
        {/* MDXEditor with z-index override for toolbar and scroll fix */}
        {/* eslint-disable-next-line react/no-unknown-property */}
        <style jsx global>{`
          .mdxeditor-toolbar {
            z-index: 60 !important;
            position: relative;
            flex-shrink: 0;
          }
          .mdxeditor-popup,
          .mdxeditor-dialog,
          ._popoverSurface_9pz9d_293 {
            z-index: 65 !important;
          }
          /* Fix: Enable mouse wheel scrolling in MDXEditor content area */
          .prompt-editor-modal-mdx [class*="_editorWrapper_"] {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
          }
          .prompt-editor-modal-mdx [class*="_editorRoot_"] {
            display: flex;
            flex-direction: column;
            height: 100%;
          }
        `}</style>
        <MDXEditor
          ref={mdxEditorRef}
          markdown={promptContent}
          onChange={handleContentChange}
          className="h-full bg-muted [&_.mdxeditor]:h-full prompt-editor-modal-mdx"
          contentEditableClassName="prose max-w-none p-4"
          placeholder="Enter your prompt content. Use ${variableName} for dynamic values."
          plugins={editorPlugins}
        />
      </div>
    </div>
  )
}

export function PromptEditorModal({
  open,
  onOpenChange,
  mode,
  promptName,
  setPromptName,
  promptContent,
  setPromptContent,
  systemContext,
  setSystemContext,
  modelId,
  setModelId,
  enabledTools,
  setEnabledTools,
  useExternalKnowledge,
  setUseExternalKnowledge,
  selectedRepositoryIds,
  setSelectedRepositoryIds,
  models,
  inputFields,
  prompts,
  editingPrompt,
  onSubmit,
  isLoading
}: PromptEditorModalProps) {
  const mdxEditorRef = useRef<MDXEditorMethods>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [isPdfContentCollapsed, setIsPdfContentCollapsed] = useState(true)
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] = useState(false)
  const currentState = useMemo(() => ({
    promptName,
    promptContent,
    systemContext,
    modelId,
    enabledTools,
    useExternalKnowledge,
    selectedRepositoryIds
  }), [promptName, promptContent, systemContext, modelId, enabledTools, useExternalKnowledge, selectedRepositoryIds])
  const hasUnsavedChanges = useUnsavedChanges(open, currentState)
  const promptTokens = useMemo(() => estimateTokens(promptContent), [promptContent])
  const contextTokens = useMemo(() => estimateTokens(systemContext), [systemContext])
  const selectedModel = useMemo(
    () => modelId ? models.find(m => m.id === Number.parseInt(modelId)) : null,
    [modelId, models]
  )

  // Available variables for insertion
  const availableVariables = useMemo(() => {
    const fieldVars = inputFields.map(f => f.name)
    const promptVars = prompts
      .filter((p, idx) => !editingPrompt ? true : prompts.findIndex(pp => pp.id === editingPrompt.id) > idx)
      .map(prevPrompt => slugify(prevPrompt.name))
    return [...fieldVars, ...promptVars]
  }, [inputFields, prompts, editingPrompt])

  // Handle variable insertion
  const handleInsertVariable = useCallback((variable: string) => {
    if (mdxEditorRef.current?.insertMarkdown) {
      mdxEditorRef.current?.insertMarkdown(variable)
      mdxEditorRef.current?.focus?.()
      toast.success(`Inserted: ${variable}`, { duration: 1500 })
    }
  }, [])

  // Handle close with unsaved changes check
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen && hasUnsavedChanges) {
      setShowUnsavedChangesDialog(true)
    } else {
      onOpenChange(newOpen)
    }
  }, [hasUnsavedChanges, onOpenChange])
  const handleDiscardChanges = useCallback(() => {
    setShowUnsavedChangesDialog(false)
    onOpenChange(false)
  }, [onOpenChange])
  const handleInteractOutside = useCallback((e: Event) => {
    if (hasUnsavedChanges) {
      e.preventDefault()
      setShowUnsavedChangesDialog(true)
    }
  }, [hasUnsavedChanges])
  const handleCancelClick = useCallback(() => handleOpenChange(false), [handleOpenChange])

  // Handle continue editing (dismiss unsaved changes dialog)
  const handleContinueEditing = useCallback(() => {
    setShowUnsavedChangesDialog(false)
  }, [])

  // Keyboard shortcut for save (Cmd/Ctrl+S)
  useKeyboardShortcut(open, formRef)

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            className="rounded-lg border bg-background shadow-lg p-0 flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
            style={DIALOG_CONTENT_STYLE}
            onInteractOutside={handleInteractOutside}
          >
            <form
              ref={formRef}
              onSubmit={onSubmit}
              className="flex flex-col h-full"
            >
              <DialogHeader mode={mode} />
              <MainContentArea
                promptName={promptName}
                setPromptName={setPromptName}
                modelId={modelId}
                setModelId={setModelId}
                enabledTools={enabledTools}
                setEnabledTools={setEnabledTools}
                useExternalKnowledge={useExternalKnowledge}
                setUseExternalKnowledge={setUseExternalKnowledge}
                systemContext={systemContext}
                setSystemContext={setSystemContext}
                selectedRepositoryIds={selectedRepositoryIds}
                setSelectedRepositoryIds={setSelectedRepositoryIds}
                isPdfContentCollapsed={isPdfContentCollapsed}
                setIsPdfContentCollapsed={setIsPdfContentCollapsed}
                contextTokens={contextTokens}
                availableVariables={availableVariables}
                handleInsertVariable={handleInsertVariable}
                models={models}
                isLoading={isLoading}
                promptContent={promptContent}
                setPromptContent={setPromptContent}
                promptTokens={promptTokens}
                maxTokens={selectedModel?.maxTokens}
                mdxEditorRef={mdxEditorRef}
              />
              <DialogFooter
                mode={mode}
                isLoading={isLoading}
                hasUnsavedChanges={hasUnsavedChanges}
                onCancel={handleCancelClick}
              />
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <UnsavedChangesDialog
        open={showUnsavedChangesDialog}
        onContinueEditing={handleContinueEditing}
        onDiscardChanges={handleDiscardChanges}
      />
    </>
  )
}
