"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { X } from "lucide-react"
import { TagFilterDropdown } from "./tag-filter-dropdown"

interface SearchFilterBarProps {
  selectedTags: string[]
  onTagsChange: (tags: string[]) => void
  sortBy: 'created' | 'usage' | 'views'
  onSortChange: (sort: 'created' | 'usage' | 'views') => void
  totalCount: number
}

export function SearchFilterBar({
  selectedTags,
  onTagsChange,
  sortBy,
  onSortChange,
  totalCount
}: SearchFilterBarProps) {
  const handleRemoveTag = (tagToRemove: string) => {
    onTagsChange(selectedTags.filter((tag) => tag !== tagToRemove))
  }

  const handleClearFilters = () => {
    onTagsChange([])
  }

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 bg-muted/50 rounded-lg border">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Sort Dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            Sort by:
          </span>
          <Select value={sortBy} onValueChange={onSortChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="usage">Most Used</SelectItem>
              <SelectItem value="views">Most Viewed</SelectItem>
              <SelectItem value="created">Most Recent</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Separator */}
        <div className="h-6 w-px bg-border" />

        {/* Tag Filter Dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            Filter by tags:
          </span>
          <TagFilterDropdown
            selectedTags={selectedTags}
            onTagsChange={onTagsChange}
          />
        </div>

        {/* Selected Tags Display */}
        {selectedTags.length > 0 && (
          <>
            <div className="h-6 w-px bg-border" />
            <div className="flex items-center gap-2 flex-wrap">
              {selectedTags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-1 hover:text-destructive"
                    aria-label={`Remove ${tag} tag`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearFilters}
                className="h-6 text-xs"
              >
                Clear all
              </Button>
            </div>
          </>
        )}
      </div>

      <div className="text-sm text-muted-foreground">
        {totalCount} {totalCount === 1 ? "prompt" : "prompts"}
      </div>
    </div>
  )
}
