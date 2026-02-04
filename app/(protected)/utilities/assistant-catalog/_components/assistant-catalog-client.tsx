"use client"

import { useMemo, useState, useEffect, startTransition } from "react"
import { useDebounce } from "use-debounce"
import { Search, X, Star } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAssistantCatalogStore, type CategoryFilter } from "@/lib/stores/assistant-catalog-store"
import type { CatalogAssistant } from "@/actions/assistant-catalog.actions"
import { AssistantCard } from "./assistant-card"
import { EmptyState } from "./empty-state"

interface AssistantCatalogClientProps {
  initialAssistants: CatalogAssistant[]
}

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  pedagogical: 'Pedagogical Tools',
  operational: 'Operational',
  communications: 'Communications',
  favorites: 'Favorites'
}

export function AssistantCatalogClient({ initialAssistants }: AssistantCatalogClientProps) {
  const {
    searchQuery,
    setSearchQuery,
    selectedCategory,
    setSelectedCategory,
    favoriteIds,
    clearFilters
  } = useAssistantCatalogStore()

  // Debounce search for performance
  const [debouncedSearch] = useDebounce(searchQuery, 300)

  // Track if store is hydrated (to avoid hydration mismatch)
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    startTransition(() => { setIsHydrated(true) })
  }, [])

  // Filter assistants based on category, search, and favorites
  const filteredAssistants = useMemo(() => {
    let filtered = initialAssistants

    // Category filter
    if (selectedCategory === 'favorites') {
      filtered = filtered.filter(a => favoriteIds.has(a.id))
    } else if (selectedCategory !== 'all') {
      filtered = filtered.filter(a => a.category === selectedCategory)
    }

    // Search filter
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase()
      filtered = filtered.filter(
        a =>
          a.name.toLowerCase().includes(query) ||
          (a.description && a.description.toLowerCase().includes(query))
      )
    }

    return filtered
  }, [initialAssistants, selectedCategory, debouncedSearch, favoriteIds])

  // Calculate category counts
  const categoryCounts = useMemo(() => {
    return {
      all: initialAssistants.length,
      pedagogical: initialAssistants.filter(a => a.category === 'pedagogical').length,
      operational: initialAssistants.filter(a => a.category === 'operational').length,
      communications: initialAssistants.filter(a => a.category === 'communications').length,
      favorites: isHydrated ? favoriteIds.size : 0
    }
  }, [initialAssistants, favoriteIds, isHydrated])

  // Get unique categories present in the data
  const availableCategories: CategoryFilter[] = useMemo(() => {
    const categories: CategoryFilter[] = ['all']

    if (categoryCounts.pedagogical > 0) categories.push('pedagogical')
    if (categoryCounts.operational > 0) categories.push('operational')
    if (categoryCounts.communications > 0) categories.push('communications')

    // Always show favorites tab
    categories.push('favorites')

    return categories
  }, [categoryCounts])

  const hasActiveFilters = searchQuery !== '' || selectedCategory !== 'all'

  return (
    <Card>
      <CardHeader className="space-y-4">
        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search assistants by name or description..."
            className="pl-10 pr-10"
            aria-label="Search assistants"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Category Tabs */}
        <Tabs
          value={selectedCategory}
          onValueChange={(v) => setSelectedCategory(v as CategoryFilter)}
        >
          <TabsList className="w-full justify-start flex-wrap h-auto gap-1">
            {availableCategories.map((category) => (
              <TabsTrigger
                key={category}
                value={category}
                className="flex items-center gap-1.5"
              >
                {category === 'favorites' && <Star className="h-3.5 w-3.5" />}
                {CATEGORY_LABELS[category]}
                <span className="text-xs text-muted-foreground ml-1">
                  ({categoryCounts[category]})
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent>
        {/* Results Count & Clear Filters */}
        {hasActiveFilters && (
          <div className="flex items-center justify-between mb-4 text-sm text-muted-foreground">
            <span>
              {filteredAssistants.length} assistant{filteredAssistants.length !== 1 ? 's' : ''} found
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-auto py-1 px-2"
            >
              Clear filters
            </Button>
          </div>
        )}

        {/* Assistant Grid */}
        {filteredAssistants.length === 0 ? (
          <EmptyState
            category={selectedCategory}
            searchQuery={debouncedSearch}
            onClearFilters={clearFilters}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredAssistants.map((assistant) => (
              <AssistantCard key={assistant.id} assistant={assistant} isHydrated={isHydrated} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
