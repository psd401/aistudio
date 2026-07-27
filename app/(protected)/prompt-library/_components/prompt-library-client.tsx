"use client"

import { useState, useEffect, useEffectEvent, useRef } from "react"
import { useRouter } from "next/navigation"
import { listPrompts } from "@/actions/prompt-library.actions"
import { useAction } from "@/lib/hooks/use-action"
import { usePromptLibraryStore } from "@/lib/stores/prompt-library-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Card,
  CardContent,
  CardHeader
} from "@/components/ui/card"
import {
  LayoutGrid,
  List,
  Plus,
  Search,
  Globe
} from "lucide-react"
import { useDebounce } from "use-debounce"
import { useHotkeys } from "react-hotkeys-hook"
import { PromptCard } from "./prompt-card"
import { PromptListItem } from "./prompt-list-item"
import { SearchFilterBar } from "./search-filter-bar"
import { BulkActionsBar } from "./bulk-actions-bar"
import { EmptyState } from "./empty-state"
import type { PromptListItem as PromptListItemType } from "@/lib/prompt-library/types"
import { PageBranding } from "@/components/ui/page-branding"

interface PromptFilters {
  search: string
  tags: string[]
  visibility: ReturnType<typeof usePromptLibraryStore.getState>["visibilityFilter"]
  sort: ReturnType<typeof usePromptLibraryStore.getState>["sortBy"]
}

function usePromptResults({ search, tags, visibility, sort }: PromptFilters) {
  const [prompts, setPrompts] = useState<PromptListItemType[]>([])
  const [loading, setLoading] = useState(true)
  const { execute } = useAction(listPrompts, {
    showSuccessToast: false,
    showErrorToast: false
  })
  const executeLatest = useEffectEvent(execute)

  useEffect(() => {
    let cancelled = false
    async function loadPrompts() {
      setLoading(true)
      const result = await executeLatest({
        search: search || undefined,
        tags: tags.length > 0 ? tags : undefined,
        visibility: visibility === "all" ? undefined : visibility,
        sort,
        page: 1,
        limit: 100
      })
      if (!cancelled && result?.isSuccess && result.data) {
        setPrompts(result.data.prompts)
      }
      if (!cancelled) setLoading(false)
    }

    void loadPrompts()
    return () => {
      cancelled = true
    }
  }, [search, tags, visibility, sort])

  return { prompts, setPrompts, loading }
}

function PromptLibraryHeader({
  onBrowsePublic,
  onCreatePrompt,
}: {
  onBrowsePublic: () => void
  onCreatePrompt: () => void
}) {
  return (
    <div className="mb-6">
      <PageBranding />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Prompt Library</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage and organize your saved prompts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onBrowsePublic}>
            <Globe className="mr-2 h-4 w-4" />
            Browse Public
          </Button>
          <Button onClick={onCreatePrompt}>
            <Plus className="mr-2 h-4 w-4" />
            New Prompt
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PromptLibraryClient() {
  const router = useRouter()
  const searchInputRef = useRef<HTMLInputElement>(null)

  const {
    viewMode,
    setViewMode,
    searchQuery,
    selectedTags,
    visibilityFilter,
    sortBy,
    selectedPrompts,
    clearSelection
  } = usePromptLibraryStore()

  const [debouncedSearch] = useDebounce(searchQuery, 300)
  const { prompts, setPrompts, loading } = usePromptResults({
    search: debouncedSearch,
    tags: selectedTags,
    visibility: visibilityFilter,
    sort: sortBy,
  })

  const selectedCount = selectedPrompts.size

  // Keyboard shortcuts
  useHotkeys('/', (e) => {
    e.preventDefault()
    searchInputRef.current?.focus()
  }, { enableOnFormTags: false })

  useHotkeys('mod+n', (e) => {
    e.preventDefault()
    router.push('/prompt-library/new')
  })

  useHotkeys('mod+a', (e) => {
    e.preventDefault()
    if (prompts.length > 0) {
      usePromptLibraryStore.getState().selectAll(prompts.map(p => p.id))
    }
  })

  useHotkeys('escape', () => {
    if (selectedCount > 0) {
      clearSelection()
    }
  })

  return (
    <>
      <PromptLibraryHeader
        onBrowsePublic={() => router.push('/prompt-library/public')}
        onCreatePrompt={() => router.push('/prompt-library/new')}
      />

      <Card>
        <CardHeader>
          {/* Search and View Toggle */}
          <div className="flex items-center gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) =>
                usePromptLibraryStore.getState().setSearchQuery(e.target.value)
              }
              placeholder="Search prompts... (Press / to focus)"
              className="pl-10"
            />
          </div>

          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'grid' | 'list')}>
            <TabsList>
              <TabsTrigger value="grid">
                <LayoutGrid className="h-4 w-4" />
              </TabsTrigger>
              <TabsTrigger value="list">
                <List className="h-4 w-4" />
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>

      <CardContent>
        {/* Filters */}
        <SearchFilterBar />

        {/* Bulk Actions */}
        {selectedCount > 0 && (
          <BulkActionsBar
            selectedCount={selectedCount}
            onClearSelection={clearSelection}
            onDelete={() => {
              // Reload prompts after bulk delete
              const selectedIds = Array.from(selectedPrompts)
              setPrompts(prompts.filter(p => !selectedIds.includes(p.id)))
            }}
          />
        )}

        {/* Content Area */}
        <div className="mt-6">
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          ) : prompts.length === 0 ? (
            <EmptyState />
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {prompts.map((prompt) => (
                <PromptCard
                  key={prompt.id}
                  prompt={prompt}
                  onDelete={() => {
                    // Reload prompts after delete
                    setPrompts(prompts.filter(p => p.id !== prompt.id))
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {prompts.map((prompt) => (
                <PromptListItem
                  key={prompt.id}
                  prompt={prompt}
                  onDelete={() => {
                    // Reload prompts after delete
                    setPrompts(prompts.filter(p => p.id !== prompt.id))
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
    </>
  )
}
