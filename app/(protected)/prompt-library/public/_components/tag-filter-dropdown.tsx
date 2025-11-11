"use client"

import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { getPopularTags } from "@/actions/prompt-library-tags.actions"
import type { PromptTag } from "@/lib/prompt-library/types"
import { createLogger } from "@/lib/client-logger"

const log = createLogger({ moduleName: "tag-filter-dropdown" })

interface TagFilterDropdownProps {
  selectedTags: string[]
  onTagsChange: (tags: string[]) => void
}

export function TagFilterDropdown({
  selectedTags,
  onTagsChange
}: TagFilterDropdownProps) {
  const [availableTags, setAvailableTags] = useState<
    Array<PromptTag & { usageCount: number }>
  >([])
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadTags()
  }, [])

  const loadTags = async () => {
    setLoading(true)
    try {
      const result = await getPopularTags(50)
      if (result.isSuccess) {
        setAvailableTags(result.data)
      } else {
        // Handle failure gracefully - show empty state
        log.error("Failed to load tags", { message: result.message })
        setAvailableTags([])
      }
    } catch (error) {
      // Handle unexpected errors
      log.error("Unexpected error loading tags", { error })
      setAvailableTags([])
    } finally {
      setLoading(false)
    }
  }

  const filteredTags = searchQuery
    ? availableTags.filter((tag) =>
        tag.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : availableTags

  const handleTagToggle = (tagName: string) => {
    if (selectedTags.includes(tagName)) {
      onTagsChange(selectedTags.filter((t) => t !== tagName))
    } else {
      onTagsChange([...selectedTags, tagName])
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-[180px] justify-between"
          disabled={loading}
        >
          <span className="truncate">
            {selectedTags.length > 0
              ? `${selectedTags.length} selected`
              : "Select tags"}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[240px]"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* Search Input */}
        <div className="p-2">
          <Input
            placeholder="Search tags..."
            aria-label="Search tags"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8"
          />
        </div>

        {/* Tag List */}
        <div className="max-h-[300px] overflow-y-auto">
          {loading ? (
            <div className="p-2 text-sm text-muted-foreground text-center">
              Loading tags...
            </div>
          ) : filteredTags.length === 0 ? (
            <div className="p-2 text-sm text-muted-foreground text-center">
              No tags found
            </div>
          ) : (
            filteredTags.map((tag) => (
              <DropdownMenuCheckboxItem
                key={tag.id}
                checked={selectedTags.includes(tag.name)}
                onCheckedChange={() => handleTagToggle(tag.name)}
                onSelect={(e) => e.preventDefault()}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{tag.name}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {tag.usageCount}
                  </span>
                </div>
              </DropdownMenuCheckboxItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
