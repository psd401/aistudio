"use client"

import { Search, Star, FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CategoryFilter } from "@/lib/stores/assistant-catalog-store"

interface EmptyStateProps {
  category: CategoryFilter
  searchQuery: string
  onClearFilters: () => void
}

export function EmptyState({ category, searchQuery, onClearFilters }: EmptyStateProps) {
  // Different messages based on filter state
  if (category === 'favorites' && !searchQuery) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <Star className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-lg mb-2">No favorites yet</h3>
        <p className="text-sm text-muted-foreground max-w-md mb-4">
          Click the star icon on any assistant to add it to your favorites for quick access.
        </p>
        <Button variant="outline" onClick={onClearFilters}>
          Browse all assistants
        </Button>
      </div>
    )
  }

  if (searchQuery) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <Search className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-lg mb-2">No assistants found</h3>
        <p className="text-sm text-muted-foreground max-w-md mb-4">
          No assistants match your search for &quot;{searchQuery}&quot;.
          Try a different search term or clear your filters.
        </p>
        <Button variant="outline" onClick={onClearFilters}>
          Clear filters
        </Button>
      </div>
    )
  }

  // Category filter with no results
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <FolderOpen className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="font-semibold text-lg mb-2">No assistants in this category</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-4">
        There are no assistants available in the selected category.
        Try selecting a different category or view all assistants.
      </p>
      <Button variant="outline" onClick={onClearFilters}>
        View all assistants
      </Button>
    </div>
  )
}
