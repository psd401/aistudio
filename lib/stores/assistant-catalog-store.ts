import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CategoryFilter = 'all' | 'pedagogical' | 'operational' | 'communications' | 'favorites'

interface AssistantCatalogState {
  // View State
  searchQuery: string
  selectedCategory: CategoryFilter
  favoriteIds: Set<number>

  // Actions
  setSearchQuery: (query: string) => void
  setSelectedCategory: (category: CategoryFilter) => void
  toggleFavorite: (id: number) => void
  isFavorite: (id: number) => boolean
  clearFilters: () => void
}

export const useAssistantCatalogStore = create<AssistantCatalogState>()(
  persist(
    (set, get) => ({
      // Initial State
      searchQuery: '',
      selectedCategory: 'all',
      favoriteIds: new Set<number>(),

      // Actions
      setSearchQuery: (query) => set({ searchQuery: query }),

      setSelectedCategory: (category) => set({ selectedCategory: category }),

      toggleFavorite: (id) =>
        set((state) => {
          const newFavorites = new Set(state.favoriteIds)
          if (newFavorites.has(id)) {
            newFavorites.delete(id)
          } else {
            newFavorites.add(id)
          }
          return { favoriteIds: newFavorites }
        }),

      isFavorite: (id) => get().favoriteIds.has(id),

      clearFilters: () =>
        set({
          searchQuery: '',
          selectedCategory: 'all'
        })
    }),
    {
      name: 'assistant-catalog-preferences',
      partialize: (state) => ({
        // Only persist favorites - search and category are ephemeral
        favoriteIds: Array.from(state.favoriteIds)
      }),
      // Custom storage to handle Set serialization
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name)
          if (!str) return null
          try {
            const parsed = JSON.parse(str)
            // Convert array back to Set
            if (parsed.state?.favoriteIds) {
              parsed.state.favoriteIds = new Set(parsed.state.favoriteIds)
            }
            return parsed
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          // Convert Set to array for serialization
          const toStore = {
            ...value,
            state: {
              ...value.state,
              favoriteIds: value.state?.favoriteIds
                ? Array.from(value.state.favoriteIds)
                : []
            }
          }
          localStorage.setItem(name, JSON.stringify(toStore))
        },
        removeItem: (name) => localStorage.removeItem(name)
      }
    }
  )
)
