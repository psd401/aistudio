"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  createRepository,
  getUserAccessibleRepositoriesAction,
  type AccessibleRepositorySummary,
} from "@/actions/repositories/repository.actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import {
  AlertCircle,
  Check,
  FolderPlus,
  Loader2,
  Lock,
  Search,
} from "lucide-react"

export interface RepositoryPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedRepositoryIds: number[]
  onSelectionChange: (repositoryIds: number[]) => void
  selectionMode?: "single" | "multiple"
  allowCreate?: boolean
  manageableOnly?: boolean
  closeOnSelect?: boolean
  title?: string
  description?: string
  loadRepositories?: typeof getUserAccessibleRepositoriesAction
  maxSelections?: number
}

function toSummary(
  repository: NonNullable<Awaited<ReturnType<typeof createRepository>>["data"]>
): AccessibleRepositorySummary {
  return {
    id: repository.id,
    name: repository.name,
    description: repository.description,
    isPublic: repository.isPublic,
    itemCount: repository.itemCount ?? 0,
    readiness: repository.readiness,
    activeGenerationId: repository.activeIndexGenerationId,
    indexedItemCount: repository.indexedItemCount,
    segmentCount: repository.segmentCount,
    lastIndexError: repository.lastIndexError,
    lastUpdated: repository.updatedAt,
    canManage: repository.canManage,
  }
}

function filterRepositories(
  repositories: AccessibleRepositorySummary[],
  query: string,
  manageableOnly: boolean
): AccessibleRepositorySummary[] {
  const normalized = query.trim().toLocaleLowerCase()
  return repositories.filter((repository) => {
    if (manageableOnly && !repository.canManage) return false
    if (!normalized) return true
    return (
      repository.name.toLocaleLowerCase().includes(normalized) ||
      repository.description?.toLocaleLowerCase().includes(normalized)
    )
  })
}

function createPrivateRepository(name: string, description: string) {
  return createRepository({
    name,
    description: description.trim() || undefined,
    isPublic: false,
  })
}

interface RepositoryResultsProps {
  loading: boolean
  error: string | null
  repositories: AccessibleRepositorySummary[]
  manageableOnly: boolean
  selectedRepositoryIds: number[]
  onRetry: () => void
  onSelect: (repositoryId: number) => void
}

function RepositoryResults({
  loading,
  error,
  repositories,
  manageableOnly,
  selectedRepositoryIds,
  onRetry,
  onSelect,
}: RepositoryResultsProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading repositories…
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Repositories unavailable</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (repositories.length === 0) {
    return (
      <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
        {manageableOnly
          ? "No repositories you can manage match this search."
          : "No accessible repositories match this search."}
      </p>
    )
  }
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
      {repositories.map((repository) => {
        const selected = selectedRepositoryIds.includes(repository.id)
        return (
          <button
            key={repository.id}
            type="button"
            className="flex w-full items-center justify-between gap-4 rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
            onClick={() => onSelect(repository.id)}
            aria-pressed={selected}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{repository.name}</span>
                <Badge variant="outline">
                  {repository.canManage ? "Managed by you" : "Shared"}
                </Badge>
                <Badge
                  variant={
                    repository.readiness === "searchable"
                      ? "default"
                      : repository.readiness === "degraded"
                        ? "secondary"
                        : "outline"
                  }
                  className="capitalize"
                >
                  {repository.readiness}
                </Badge>
                {!repository.isPublic ? (
                  <Lock
                    className="h-3.5 w-3.5 text-muted-foreground"
                    aria-label="Private repository"
                  />
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {repository.description || "No description"} ·{" "}
                {repository.indexedItemCount}/{repository.itemCount} indexed ·{" "}
                {repository.segmentCount} segments
              </p>
            </div>
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : ""
              }`}
            >
              {selected ? <Check className="h-4 w-4" /> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

interface RepositoryCreatorProps {
  allowCreate: boolean
  showCreate: boolean
  creating: boolean
  newName: string
  newDescription: string
  onShowCreate: (show: boolean) => void
  onNameChange: (name: string) => void
  onDescriptionChange: (description: string) => void
  onCreate: () => void
}

function RepositoryCreator({
  allowCreate,
  showCreate,
  creating,
  newName,
  newDescription,
  onShowCreate,
  onNameChange,
  onDescriptionChange,
  onCreate,
}: RepositoryCreatorProps) {
  if (!allowCreate) return null
  if (!showCreate) {
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={() => onShowCreate(true)}
      >
        <FolderPlus className="mr-2 h-4 w-4" />
        Create private repository
      </Button>
    )
  }
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div>
        <p className="font-medium">Create a private repository</p>
        <p className="text-xs text-muted-foreground">
          New repositories created here are private by default.
        </p>
      </div>
      <Input
        value={newName}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="Repository name"
        aria-label="New repository name"
        maxLength={100}
      />
      <Textarea
        value={newDescription}
        onChange={(event) => onDescriptionChange(event.target.value)}
        placeholder="Description (optional)"
        aria-label="New repository description"
        maxLength={500}
        rows={2}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => onShowCreate(false)}
          disabled={creating}
        >
          Cancel
        </Button>
        <Button onClick={onCreate} disabled={!newName.trim() || creating}>
          {creating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Create and select
        </Button>
      </div>
    </div>
  )
}

// eslint-disable-next-line max-lines-per-function -- Picker orchestration keeps its load, selection, creation, and dialog state colocated.
export function RepositoryPicker({
  open,
  onOpenChange,
  selectedRepositoryIds,
  onSelectionChange,
  selectionMode = "single",
  allowCreate = true,
  manageableOnly = false,
  closeOnSelect = true,
  title = "Choose a repository",
  description = "Select an accessible durable knowledge repository.",
  loadRepositories = getUserAccessibleRepositoriesAction,
  maxSelections,
}: RepositoryPickerProps) {
  const { toast } = useToast()
  const [repositories, setRepositories] =
    useState<AccessibleRepositorySummary[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")

  const load = useCallback(async () => {
    const result = await loadRepositories()
    if (result.isSuccess && result.data) {
      setRepositories(result.data)
      setError(null)
    } else {
      setError(result.message || "Accessible repositories could not be loaded")
    }
    setLoading(false)
  }, [loadRepositories])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function loadInitialRepositories() {
      const result = await loadRepositories()
      if (cancelled) return
      if (result.isSuccess && result.data) {
        setRepositories(result.data)
        setError(null)
      } else {
        setError(result.message || "Accessible repositories could not be loaded")
      }
      setLoading(false)
    }
    void loadInitialRepositories()
    return () => {
      cancelled = true
    }
  }, [loadRepositories, open])

  const visibleRepositories = useMemo(
    () => filterRepositories(repositories, query, manageableOnly),
    [manageableOnly, query, repositories]
  )

  function selectRepository(repositoryId: number) {
    if (selectionMode === "single") {
      onSelectionChange([repositoryId])
      if (closeOnSelect) onOpenChange(false)
      return
    }

    const selected = selectedRepositoryIds.includes(repositoryId)
    if (
      !selected &&
      maxSelections !== undefined &&
      selectedRepositoryIds.length >= maxSelections
    ) {
      toast({
        title: "Repository limit reached",
        description: `Select at most ${maxSelections} repositories for this conversation.`,
        variant: "destructive",
      })
      return
    }
    const next = selected
      ? selectedRepositoryIds.filter((id) => id !== repositoryId)
      : [...selectedRepositoryIds, repositoryId]
    onSelectionChange(next)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    const result = await createPrivateRepository(name, newDescription)
    if (result.isSuccess && result.data) {
      const repository = toSummary(result.data)
      setRepositories((current) => [repository, ...current])
      setNewName("")
      setNewDescription("")
      setShowCreate(false)
      toast({
        title: "Private repository created",
        description: `${repository.name} is ready for content.`,
      })
      if (selectionMode === "single") {
        onSelectionChange([repository.id])
        if (closeOnSelect) onOpenChange(false)
      } else {
        onSelectionChange([...selectedRepositoryIds, repository.id])
      }
    } else {
      toast({
        title: "Could not create repository",
        description: result.message || "Repository creation failed",
        variant: "destructive",
      })
    }
    setCreating(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
              placeholder="Search repositories"
              aria-label="Search repositories"
            />
          </div>

          <RepositoryResults
            loading={loading}
            error={error}
            repositories={visibleRepositories}
            manageableOnly={manageableOnly}
            selectedRepositoryIds={selectedRepositoryIds}
            onRetry={() => {
              setLoading(true)
              setError(null)
              void load()
            }}
            onSelect={selectRepository}
          />

          <RepositoryCreator
            allowCreate={allowCreate}
            showCreate={showCreate}
            creating={creating}
            newName={newName}
            newDescription={newDescription}
            onShowCreate={setShowCreate}
            onNameChange={setNewName}
            onDescriptionChange={setNewDescription}
            onCreate={() => void handleCreate()}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
