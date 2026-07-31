"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { usePromptLibraryStore, type VisibilityFilter, type SortBy } from "@/lib/stores/prompt-library-store"
import { X } from "lucide-react"
import { meridianPortalClassName } from "@/lib/meridian/fonts"

export function SearchFilterBar() {
  const {
    selectedTags,
    visibilityFilter,
    sortBy,
    setVisibilityFilter,
    setSortBy,
    removeTag,
    clearFilters
  } = usePromptLibraryStore()

  const hasActiveFilters =
    selectedTags.length > 0 || visibilityFilter !== 'all' || sortBy !== 'created'

  return (
    <div className="border-b px-6 py-3">
      <div className="flex items-center gap-4">
        {/* Visibility Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Visibility:</span>
          <Select
            value={visibilityFilter}
            onValueChange={(v) => setVisibilityFilter(v as VisibilityFilter)}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={meridianPortalClassName}>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="public">Public</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Sort By */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Sort by:</span>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={meridianPortalClassName}>
              <SelectItem value="created">Date Created</SelectItem>
              <SelectItem value="usage">Usage Count</SelectItem>
              <SelectItem value="views">View Count</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Active Tags */}
        {selectedTags.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Tags:</span>
            <div className="flex gap-1">
              {selectedTags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Clear Filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear all filters
          </Button>
        )}
      </div>
    </div>
  )
}
