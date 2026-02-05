"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Search, Folder, FileText, Users, Globe } from "lucide-react"
import { getUserAccessibleRepositoriesAction } from "@/actions/repositories/repository.actions"
import { toast } from "sonner"
import { Skeleton } from "@/components/ui/skeleton"

interface Repository {
  id: number
  name: string
  description: string | null
  isPublic: boolean
  itemCount: number
  lastUpdated: Date | null
}

interface RepositoryBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: number[]
  onSelectionChange: (ids: number[]) => void
}

export function RepositoryBrowser({
  open,
  onOpenChange,
  selectedIds,
  onSelectionChange
}: RepositoryBrowserProps) {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<number>>(new Set(selectedIds))

  useEffect(() => {
    if (open) {
      loadRepositories()
    }
  }, [open])

  useEffect(() => {
    setSelectedRepoIds(new Set(selectedIds))
  }, [selectedIds])

  const loadRepositories = async () => {
    setLoading(true)
    try {
      const result = await getUserAccessibleRepositoriesAction()
      if (result.isSuccess && result.data) {
        setRepositories(result.data)
      } else {
        toast.error(result.message || "Failed to load repositories")
      }
    } catch {
      toast.error("Error loading repositories")
    } finally {
      setLoading(false)
    }
  }

  const filteredRepositories = repositories.filter(repo =>
    repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (repo.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
  )

  const toggleRepository = (repoId: number) => {
    const newSelection = new Set(selectedRepoIds)
    if (newSelection.has(repoId)) {
      newSelection.delete(repoId)
    } else {
      newSelection.add(repoId)
    }
    setSelectedRepoIds(newSelection)
  }

  const handleConfirm = () => {
    onSelectionChange(Array.from(selectedRepoIds))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Browse Knowledge Repositories</DialogTitle>
          <DialogDescription>
            Select repositories to include as knowledge sources for your prompt.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Repository list */}
          <ScrollArea className="h-[400px] border rounded-md p-4">
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-[200px]" />
                    <Skeleton className="h-4 w-[300px]" />
                  </div>
                ))}
              </div>
            ) : filteredRepositories.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                {searchQuery ? "No repositories found matching your search." : "No repositories available."}
              </div>
            ) : (
              <div className="space-y-4">
                {filteredRepositories.map(repo => (
                  <div
                    key={repo.id}
                    className="flex items-start space-x-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      id={`repo-${repo.id}`}
                      checked={selectedRepoIds.has(repo.id)}
                      onCheckedChange={() => toggleRepository(repo.id)}
                    />
                    <div className="flex-1 space-y-1">
                      <Label
                        htmlFor={`repo-${repo.id}`}
                        className="text-sm font-medium cursor-pointer flex items-center gap-2"
                      >
                        <Folder className="h-4 w-4" />
                        {repo.name}
                        {repo.isPublic ? (
                          <Badge variant="secondary" className="text-xs">
                            <Globe className="h-3 w-3 mr-1" />
                            Public
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            <Users className="h-3 w-3 mr-1" />
                            Private
                          </Badge>
                        )}
                      </Label>
                      {repo.description && (
                        <p className="text-xs text-muted-foreground">
                          {repo.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          {repo.itemCount} items
                        </span>
                        {repo.lastUpdated && (
                          <span>
                            Updated {repo.lastUpdated.toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Selection summary */}
          {selectedRepoIds.size > 0 && (
            <div className="text-sm text-muted-foreground">
              {selectedRepoIds.size} repositor{selectedRepoIds.size === 1 ? 'y' : 'ies'} selected
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>
            Confirm Selection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}