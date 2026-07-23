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
    lastUpdated: repository.updatedAt,
    canManage: repository.canManage,
  }
}

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
}: RepositoryPickerProps) {
  const { toast } = useToast()
  const [repositories, setRepositories] = useState<
    AccessibleRepositorySummary[]
  >([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")

  const load = useCallback(async () => {
    const result = await getUserAccessibleRepositoriesAction()
    if (result.isSuccess && result.data) {
      setRepositories(result.data)
      setError(null)
    } else {
      setError(result.message || "Accessible repositories could not be loaded")
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function loadInitialRepositories() {
      const result = await getUserAccessibleRepositoriesAction()
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
  }, [open])

  const visibleRepositories = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return repositories.filter((repository) => {
      if (manageableOnly && !repository.canManage) return false
      if (!normalized) return true
      return (
        repository.name.toLocaleLowerCase().includes(normalized) ||
        repository.description?.toLocaleLowerCase().includes(normalized)
      )
    })
  }, [manageableOnly, query, repositories])

  function selectRepository(repositoryId: number) {
    if (selectionMode === "single") {
      onSelectionChange([repositoryId])
      if (closeOnSelect) onOpenChange(false)
      return
    }

    const next = selectedRepositoryIds.includes(repositoryId)
      ? selectedRepositoryIds.filter((id) => id !== repositoryId)
      : [...selectedRepositoryIds, repositoryId]
    onSelectionChange(next)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    const result = await createRepository({
      name,
      description: newDescription.trim() || undefined,
      isPublic: false,
    })
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

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading repositories…
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Repositories unavailable</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLoading(true)
                    setError(null)
                    void load()
                  }}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : visibleRepositories.length === 0 ? (
            <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
              {manageableOnly
                ? "No repositories you can manage match this search."
                : "No accessible repositories match this search."}
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {visibleRepositories.map((repository) => {
                const selected = selectedRepositoryIds.includes(repository.id)
                return (
                  <button
                    key={repository.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-4 rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
                    onClick={() => selectRepository(repository.id)}
                    aria-pressed={selected}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">
                          {repository.name}
                        </span>
                        <Badge variant="outline">
                          {repository.canManage ? "Managed by you" : "Shared"}
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
                        {repository.itemCount} items
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
          )}

          {allowCreate ? (
            showCreate ? (
              <div className="space-y-3 rounded-md border bg-muted/20 p-4">
                <div>
                  <p className="font-medium">Create a private repository</p>
                  <p className="text-xs text-muted-foreground">
                    New repositories created here are private by default.
                  </p>
                </div>
                <Input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Repository name"
                  aria-label="New repository name"
                  maxLength={100}
                />
                <Textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="Description (optional)"
                  aria-label="New repository description"
                  maxLength={500}
                  rows={2}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setShowCreate(false)}
                    disabled={creating}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void handleCreate()}
                    disabled={!newName.trim() || creating}
                  >
                    {creating ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Create and select
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShowCreate(true)}
              >
                <FolderPlus className="mr-2 h-4 w-4" />
                Create private repository
              </Button>
            )
          ) : null}
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
