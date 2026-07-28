"use client"

import { useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { Brain, Loader2, Pencil, Plus, Trash2, Upload, X } from "lucide-react"
import { toast } from "sonner"
import {
  addNexusMemory,
  bulkDeleteNexusMemories,
  deleteNexusMemory,
  listNexusMemories,
  setNexusMemoryEnabled,
  updateNexusMemory,
  type NexusMemoryListItem,
  type NexusMemoryTabData,
} from "@/actions/nexus/memory.actions"
import type { NexusMemoryCategory, NexusMemorySource } from "@/lib/db/schema"
import {
  MAX_BULK_MEMORY_DELETE_COUNT,
  MAX_NEXUS_MEMORY_CONTENT_CHARS,
} from "@/lib/nexus/memory/memory-constants"
import { createLogger } from "@/lib/client-logger"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

const log = createLogger({ component: "MemoryTab" })

const MEMORY_CATEGORIES: ReadonlyArray<{
  value: NexusMemoryCategory
  label: string
}> = [
  { value: "profile", label: "Profile" },
  { value: "preference", label: "Preference" },
  { value: "context", label: "Context" },
]

const SOURCE_LABELS: Record<NexusMemorySource, string> = {
  tool: "Chat",
  manual: "Manual",
  auto: "Automatic",
  "import:chatgpt": "ChatGPT import",
  "import:claude": "Claude import",
  "import:gemini": "Gemini import",
}

interface MemoryDraft {
  content: string
  category: NexusMemoryCategory
}

interface EditingMemory extends MemoryDraft {
  id: string
}

type DeleteTarget =
  | { kind: "single"; memory: NexusMemoryListItem }
  | { kind: "bulk"; memoryIds: string[] }

async function refreshAfterMemoryMutation(
  refreshMemories: () => Promise<void>,
  operation: string,
) {
  try {
    await refreshMemories()
  } catch (error) {
    log.error("Refreshing Nexus memories after a mutation failed", {
      operation,
      error: error instanceof Error ? error.message : String(error),
    })
    toast.warning(
      "The change was saved, but the memory list could not be refreshed",
    )
  }
}

function MemoryCategorySelect({
  value,
  onValueChange,
  disabled,
  triggerTestId,
}: {
  value: NexusMemoryCategory
  onValueChange: (value: NexusMemoryCategory) => void
  disabled?: boolean
  triggerTestId?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as NexusMemoryCategory)}
      disabled={disabled}
    >
      <SelectTrigger
        className="w-full sm:w-40"
        data-testid={triggerTestId}
        aria-label="Memory category"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MEMORY_CATEGORIES.map((category) => (
          <SelectItem key={category.value} value={category.value}>
            {category.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AddMemoryDialog({
  open,
  isSaving,
  onOpenChange,
  onSave,
}: {
  open: boolean
  isSaving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: MemoryDraft) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<MemoryDraft>({
    content: "",
    category: "context",
  })

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSaving) {
      setDraft({ content: "", category: "context" })
    }
    onOpenChange(nextOpen)
  }

  const handleSave = async () => {
    if (await onSave(draft)) {
      setDraft({ content: "", category: "context" })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add memory</DialogTitle>
          <DialogDescription>
            Save a durable preference, profile fact, or piece of working
            context. Personal information is rejected by the privacy check.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="new-memory-content" className="text-sm font-medium">
              What should Nexus remember?
            </label>
            <Textarea
              id="new-memory-content"
              data-testid="memory-add-content"
              value={draft.content}
              maxLength={MAX_NEXUS_MEMORY_CONTENT_CHARS}
              disabled={isSaving}
              placeholder="For example: I prefer concise answers with a short summary."
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  content: event.target.value,
                }))
              }
            />
            <p className="text-right text-xs text-muted-foreground">
              {draft.content.length}/{MAX_NEXUS_MEMORY_CONTENT_CHARS}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Category</p>
            <MemoryCategorySelect
              value={draft.category}
              disabled={isSaving}
              triggerTestId="memory-add-category"
              onValueChange={(category) =>
                setDraft((current) => ({ ...current, category }))
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="memory-add-save"
            disabled={!draft.content.trim() || isSaving}
            onClick={handleSave}
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save memory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MemoryEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Brain className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="font-semibold">No memories yet</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Add a memory here or ask Nexus to remember a durable fact during a
        conversation.
      </p>
    </div>
  )
}

function MemoryBadges({ memory }: { memory: NexusMemoryListItem }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="secondary" className="capitalize">
        {memory.category}
      </Badge>
      <Badge variant="outline">{SOURCE_LABELS[memory.source]}</Badge>
    </div>
  )
}

function MemoryRow({
  memory,
  selected,
  selectionDisabled,
  writeDisabled,
  editing,
  isSaving,
  onSelectedChange,
  onStartEditing,
  onEditingChange,
  onCancelEditing,
  onSave,
  onDelete,
}: {
  memory: NexusMemoryListItem
  selected: boolean
  selectionDisabled: boolean
  writeDisabled: boolean
  editing: EditingMemory | null
  isSaving: boolean
  onSelectedChange: (selected: boolean) => void
  onStartEditing: () => void
  onEditingChange: (editing: EditingMemory) => void
  onCancelEditing: () => void
  onSave: () => void
  onDelete: () => void
}) {
  const isEditing = editing?.id === memory.id

  return (
    <div
      className="rounded-lg border p-4"
      data-testid="memory-row"
      data-memory-id={memory.id}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          disabled={selectionDisabled}
          aria-label={`Select memory: ${memory.content}`}
          className="mt-1"
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
        />
        <div className="min-w-0 flex-1 space-y-3">
          {isEditing && editing ? (
            <>
              <Textarea
                value={editing.content}
                maxLength={MAX_NEXUS_MEMORY_CONTENT_CHARS}
                disabled={isSaving || writeDisabled}
                data-testid="memory-edit-content"
                aria-label="Edit memory content"
                onChange={(event) =>
                  onEditingChange({
                    ...editing,
                    content: event.target.value,
                  })
                }
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <MemoryCategorySelect
                  value={editing.category}
                  disabled={isSaving || writeDisabled}
                  triggerTestId="memory-edit-category"
                  onValueChange={(category) =>
                    onEditingChange({ ...editing, category })
                  }
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isSaving}
                    onClick={onCancelEditing}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="memory-edit-save"
                    disabled={
                      !editing.content.trim() || isSaving || writeDisabled
                    }
                    onClick={onSave}
                  >
                    {isSaving && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Save
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-sm">
                {memory.content}
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-2">
                  <MemoryBadges memory={memory} />
                  <p className="text-xs text-muted-foreground">
                    Created{" "}
                    {formatDistanceToNow(new Date(memory.createdAt), {
                      addSuffix: true,
                    })}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Edit memory: ${memory.content}`}
                    disabled={writeDisabled}
                    onClick={onStartEditing}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    aria-label={`Delete memory: ${memory.content}`}
                    onClick={onDelete}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function useMemoryCollection(initialData: NexusMemoryTabData) {
  const [memories, setMemories] = useState(initialData.memories)
  const [memoryEnabled, setMemoryEnabled] = useState(initialData.memoryEnabled)
  const [globalMemoryEnabled, setGlobalMemoryEnabled] = useState(
    initialData.globalMemoryEnabled,
  )
  const [nextCursor, setNextCursor] = useState(initialData.nextCursor)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  const refreshMemories = async () => {
    const result = await listNexusMemories()
    if (!result.isSuccess) throw new Error(result.message)
    setMemories(result.data.memories)
    setMemoryEnabled(result.data.memoryEnabled)
    setGlobalMemoryEnabled(result.data.globalMemoryEnabled)
    setNextCursor(result.data.nextCursor)
    setSelectedIds((current) => {
      const liveIds = new Set(result.data.memories.map((memory) => memory.id))
      return new Set([...current].filter((id) => liveIds.has(id)))
    })
  }

  const loadMore = async () => {
    if (!nextCursor || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      const result = await listNexusMemories({ cursor: nextCursor })
      if (!result.isSuccess) {
        toast.error(result.message)
        return
      }
      setMemories((current) => {
        const existingIds = new Set(current.map((memory) => memory.id))
        return [
          ...current,
          ...result.data.memories.filter(
            (memory) => !existingIds.has(memory.id),
          ),
        ]
      })
      setMemoryEnabled(result.data.memoryEnabled)
      setGlobalMemoryEnabled(result.data.globalMemoryEnabled)
      setNextCursor(result.data.nextCursor)
    } catch (error) {
      log.error("Loading more Nexus memories failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error("Failed to load more memories")
    } finally {
      setIsLoadingMore(false)
    }
  }

  const upsertMemory = (memory: NexusMemoryListItem) => {
    setMemories((current) => [
      memory,
      ...current.filter((item) => item.id !== memory.id),
    ])
  }

  const removeMemories = (memoryIds: readonly string[]) => {
    const removedIds = new Set(memoryIds)
    setMemories((current) =>
      current.filter((memory) => !removedIds.has(memory.id)),
    )
    setSelectedIds(
      (current) =>
        new Set([...current].filter((id) => !removedIds.has(id))),
    )
  }

  const setSelected = (memoryId: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (
        selected &&
        !next.has(memoryId) &&
        next.size >= MAX_BULK_MEMORY_DELETE_COUNT
      ) {
        return current
      }
      if (selected) next.add(memoryId)
      else next.delete(memoryId)
      return next
    })
  }

  const selectAll = (selected: boolean) => {
    setSelectedIds(
      selected
        ? new Set(
            memories
              .slice(0, MAX_BULK_MEMORY_DELETE_COUNT)
              .map((memory) => memory.id),
          )
        : new Set(),
    )
  }

  const selectableMemories = memories.slice(0, MAX_BULK_MEMORY_DELETE_COUNT)

  return {
    memories,
    memoryEnabled,
    globalMemoryEnabled,
    nextCursor,
    isLoadingMore,
    selectedIds,
    allSelected:
      selectableMemories.length > 0 &&
      selectableMemories.every((memory) => selectedIds.has(memory.id)),
    selectionLimitReached: selectedIds.size >= MAX_BULK_MEMORY_DELETE_COUNT,
    setMemoryEnabled,
    setSelectedIds,
    setSelected,
    selectAll,
    refreshMemories,
    loadMore,
    upsertMemory,
    removeMemories,
  }
}

function useMemoryEditing(
  refreshMemories: () => Promise<void>,
  upsertMemory: (memory: NexusMemoryListItem) => void,
) {
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<EditingMemory | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [savingMemoryId, setSavingMemoryId] = useState<string | null>(null)

  const handleAdd = async (draft: MemoryDraft): Promise<boolean> => {
    setIsAdding(true)
    try {
      const result = await addNexusMemory(draft)
      if (!result.isSuccess) {
        toast.error(result.message)
        return false
      }
      upsertMemory(result.data)
      setAddOpen(false)
      toast.success(result.message)
      await refreshAfterMemoryMutation(refreshMemories, "add")
      return true
    } catch (error) {
      log.error("Adding Nexus memory failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error("Failed to add memory")
      return false
    } finally {
      setIsAdding(false)
    }
  }

  const handleUpdate = async () => {
    if (!editing) return
    setSavingMemoryId(editing.id)
    try {
      const result = await updateNexusMemory({
        memoryId: editing.id,
        content: editing.content,
        category: editing.category,
      })
      if (!result.isSuccess) {
        toast.error(result.message)
        return
      }
      upsertMemory(result.data)
      setEditing(null)
      toast.success(result.message)
      await refreshAfterMemoryMutation(refreshMemories, "update")
    } catch (error) {
      log.error("Updating Nexus memory failed", {
        memoryId: editing.id,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error("Failed to update memory")
    } finally {
      setSavingMemoryId(null)
    }
  }

  return {
    addOpen,
    editing,
    isAdding,
    savingMemoryId,
    setAddOpen,
    setEditing,
    handleAdd,
    handleUpdate,
  }
}

function useMemoryDeletion(
  refreshMemories: () => Promise<void>,
  clearSelection: () => void,
  removeMemories: (memoryIds: readonly string[]) => void,
) {
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      const result =
        deleteTarget.kind === "single"
          ? await deleteNexusMemory(deleteTarget.memory.id)
          : await bulkDeleteNexusMemories(deleteTarget.memoryIds)
      if (!result.isSuccess) {
        toast.error(result.message)
        return
      }
      const removedIds =
        deleteTarget.kind === "single"
          ? [deleteTarget.memory.id]
          : deleteTarget.memoryIds
      removeMemories(removedIds)
      if (deleteTarget.kind === "bulk") {
        clearSelection()
      }
      setDeleteTarget(null)
      toast.success(result.message)
      await refreshAfterMemoryMutation(refreshMemories, "delete")
    } catch (error) {
      log.error("Deleting Nexus memory failed", {
        kind: deleteTarget.kind,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error("Failed to delete memory")
    } finally {
      setIsDeleting(false)
    }
  }

  return {
    deleteTarget,
    isDeleting,
    setDeleteTarget,
    handleDelete,
  }
}

function useMemoryToggle(
  memoryEnabled: boolean,
  setMemoryEnabled: (enabled: boolean) => void,
) {
  const [isToggling, setIsToggling] = useState(false)

  const handleEnabledChange = async (enabled: boolean) => {
    const previous = memoryEnabled
    setMemoryEnabled(enabled)
    setIsToggling(true)
    try {
      const result = await setNexusMemoryEnabled(enabled)
      if (!result.isSuccess) {
        setMemoryEnabled(previous)
        toast.error(result.message)
        return
      }
      toast.success(result.message)
    } catch (error) {
      setMemoryEnabled(previous)
      log.error("Updating Nexus memory preference failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error("Failed to update memory preference")
    } finally {
      setIsToggling(false)
    }
  }

  return { isToggling, handleEnabledChange }
}

function MemoryCardHeader({
  writeDisabled,
  onAdd,
}: {
  writeDisabled: boolean
  onAdd: () => void
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5" />
          Nexus memory
        </CardTitle>
        <CardDescription className="mt-1">
          Review and control every durable fact Nexus can use across
          conversations.
        </CardDescription>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled
          title="Memory import is coming next"
        >
          <Upload className="mr-2 h-4 w-4" />
          Import memories
        </Button>
        <Button
          type="button"
          data-testid="memory-add-open"
          disabled={writeDisabled}
          title={
            writeDisabled
              ? "Enable Nexus memory before adding a memory"
              : undefined
          }
          onClick={onAdd}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add memory
        </Button>
      </div>
    </div>
  )
}

function MemoryToggle({
  enabled,
  globallyEnabled,
  disabled,
  onChange,
}: {
  enabled: boolean
  globallyEnabled: boolean
  disabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="pr-4">
        <p className="text-sm font-medium">Enable memory</p>
        <p className="text-sm text-muted-foreground">
          {globallyEnabled
            ? "When off, Nexus neither recalls nor saves memories for your account. Existing memories remain available here."
            : "An administrator has disabled Nexus memory globally. Existing memories remain available to review or delete."}
        </p>
      </div>
      <Switch
        checked={enabled}
        disabled={disabled}
        data-testid="memory-enabled-toggle"
        aria-label="Enable Nexus memory"
        onCheckedChange={onChange}
      />
    </div>
  )
}

function MemorySelectionBar({
  collection,
  onBulkDelete,
}: {
  collection: ReturnType<typeof useMemoryCollection>
  onBulkDelete: () => void
}) {
  if (collection.memories.length === 0) return null
  let selectionLabel = "Select all"
  if (collection.selectedIds.size > 0) {
    selectionLabel = `${collection.selectedIds.size} selected${
      collection.selectionLimitReached ? " (maximum)" : ""
    }`
  } else if (collection.memories.length > MAX_BULK_MEMORY_DELETE_COUNT) {
    selectionLabel = `Select first ${MAX_BULK_MEMORY_DELETE_COUNT}`
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3 sm:flex-row sm:items-center sm:justify-between">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={collection.allSelected}
          aria-label="Select memories for bulk deletion"
          onCheckedChange={(checked) => collection.selectAll(checked === true)}
        />
        {selectionLabel}
      </label>
      {collection.selectedIds.size > 0 && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="memory-bulk-delete"
            onClick={onBulkDelete}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete selected
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => collection.setSelectedIds(new Set())}
          >
            <X className="mr-2 h-4 w-4" />
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}

function MemoryList({
  collection,
  editor,
  deletion,
  writeDisabled,
}: {
  collection: ReturnType<typeof useMemoryCollection>
  editor: ReturnType<typeof useMemoryEditing>
  deletion: ReturnType<typeof useMemoryDeletion>
  writeDisabled: boolean
}) {
  if (collection.memories.length === 0) return <MemoryEmptyState />
  return (
    <div className="space-y-3">
      {collection.memories.map((memory) => (
        <MemoryRow
          key={memory.id}
          memory={memory}
          selected={collection.selectedIds.has(memory.id)}
          selectionDisabled={
            collection.selectionLimitReached &&
            !collection.selectedIds.has(memory.id)
          }
          writeDisabled={writeDisabled}
          editing={editor.editing}
          isSaving={editor.savingMemoryId === memory.id}
          onSelectedChange={(selected) =>
            collection.setSelected(memory.id, selected)
          }
          onStartEditing={() =>
            editor.setEditing({
              id: memory.id,
              content: memory.content,
              category: memory.category,
            })
          }
          onEditingChange={editor.setEditing}
          onCancelEditing={() => editor.setEditing(null)}
          onSave={editor.handleUpdate}
          onDelete={() => deletion.setDeleteTarget({ kind: "single", memory })}
        />
      ))}
    </div>
  )
}

function MemorySettingsCard({
  collection,
  editor,
  deletion,
  toggle,
}: {
  collection: ReturnType<typeof useMemoryCollection>
  editor: ReturnType<typeof useMemoryEditing>
  deletion: ReturnType<typeof useMemoryDeletion>
  toggle: ReturnType<typeof useMemoryToggle>
}) {
  const writeDisabled =
    !collection.globalMemoryEnabled || !collection.memoryEnabled
  const selectForBulkDelete = () =>
    deletion.setDeleteTarget({
      kind: "bulk",
      memoryIds: [...collection.selectedIds],
    })

  return (
    <Card>
      <CardHeader className="space-y-4">
        <MemoryCardHeader
          writeDisabled={writeDisabled}
          onAdd={() => editor.setAddOpen(true)}
        />
        {!collection.globalMemoryEnabled && (
          <div
            role="status"
            data-testid="memory-global-disabled"
            className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          >
            Nexus memory is disabled by an administrator. Adding, editing,
            recalling, and changing the account toggle are unavailable; you can
            still review or delete existing memories.
          </div>
        )}
        <MemoryToggle
          enabled={collection.memoryEnabled}
          globallyEnabled={collection.globalMemoryEnabled}
          disabled={toggle.isToggling || !collection.globalMemoryEnabled}
          onChange={toggle.handleEnabledChange}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <MemorySelectionBar
          collection={collection}
          onBulkDelete={selectForBulkDelete}
        />
        <MemoryList
          collection={collection}
          editor={editor}
          deletion={deletion}
          writeDisabled={writeDisabled}
        />
        {collection.nextCursor && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              data-testid="memory-load-more"
              disabled={collection.isLoadingMore}
              onClick={() => void collection.loadMore()}
            >
              {collection.isLoadingMore && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Load more memories
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MemoryDeleteDialog({
  deletion,
}: {
  deletion: ReturnType<typeof useMemoryDeletion>
}) {
  return (
    <AlertDialog
      open={deletion.deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open && !deletion.isDeleting) {
          deletion.setDeleteTarget(null)
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deletion.deleteTarget?.kind === "bulk"
              ? "Delete selected memories?"
              : "Delete this memory?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deletion.deleteTarget?.kind === "bulk"
              ? `${deletion.deleteTarget.memoryIds.length} memories will be removed from Nexus recall.`
              : "This memory will be removed from Nexus recall."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isDeleting}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="memory-delete-confirm"
            disabled={deletion.isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault()
              void deletion.handleDelete()
            }}
          >
            {deletion.isDeleting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function MemoryTabContent({
  initialData,
}: {
  initialData: NexusMemoryTabData
}) {
  const collection = useMemoryCollection(initialData)
  const editor = useMemoryEditing(
    collection.refreshMemories,
    collection.upsertMemory,
  )
  const deletion = useMemoryDeletion(
    collection.refreshMemories,
    () => collection.setSelectedIds(new Set()),
    collection.removeMemories,
  )
  const toggle = useMemoryToggle(
    collection.memoryEnabled,
    collection.setMemoryEnabled,
  )

  return (
    <>
      <MemorySettingsCard
        collection={collection}
        editor={editor}
        deletion={deletion}
        toggle={toggle}
      />
      <AddMemoryDialog
        open={editor.addOpen}
        isSaving={editor.isAdding}
        onOpenChange={editor.setAddOpen}
        onSave={editor.handleAdd}
      />
      <MemoryDeleteDialog deletion={deletion} />
    </>
  )
}

export function MemoryTab({
  initialData,
  initialError = null,
}: {
  initialData: NexusMemoryTabData | null
  initialError?: string | null
}) {
  const [data, setData] = useState(initialData)
  const [error, setError] = useState(initialError)
  const [isRetrying, setIsRetrying] = useState(false)

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      const result = await listNexusMemories()
      if (!result.isSuccess) {
        setError(result.message)
        return
      }
      setData(result.data)
      setError(null)
    } catch (retryError) {
      log.error("Retrying the initial Nexus memory load failed", {
        error:
          retryError instanceof Error
            ? retryError.message
            : String(retryError),
      })
      setError("Failed to load memories")
    } finally {
      setIsRetrying(false)
    }
  }

  if (!data) {
    return (
      <Card data-testid="memory-load-error">
        <CardHeader>
          <CardTitle>Memories could not be loaded</CardTitle>
          <CardDescription>
            {error ??
              "The memory service is temporarily unavailable. Try again."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            data-testid="memory-retry"
            disabled={isRetrying}
            onClick={() => void handleRetry()}
          >
            {isRetrying && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return <MemoryTabContent initialData={data} />
}
