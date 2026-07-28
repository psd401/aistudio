"use client"

import { useState, useEffect } from "react"
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core"
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { NavigationItem } from "./navigation-item"
import { NavigationItemForm } from "./navigation-item-form"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Navigation, AlertCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SelectNavigationItem } from "@/types/db-types"
import { PageBranding } from "@/components/ui/page-branding"

interface OrganizedItem extends SelectNavigationItem {
  children: OrganizedItem[]
  level: number
}

/**
 * Organizes navigation items into a hierarchical structure
 * @param items - Flat array of navigation items
 * @param parentId - ID of the parent item (null for top-level items)
 * @param level - Current nesting level (used for indentation)
 * @returns Array of organized items with their children
 */
function organizeItems(items: SelectNavigationItem[], parentId: number | null = null, level: number = 0): OrganizedItem[] {
  const filteredItems = items
    .filter(item => item.parentId === parentId)
    .sort((a, b) => (a.position || 0) - (b.position || 0))

  return filteredItems.map(item => ({
    ...item,
    children: organizeItems(items, item.id, level + 1),
    level
  }))
}

/**
 * Flattens a hierarchical structure of items while preserving level information
 * @param items - Array of organized items with children
 * @returns Flat array of items with level information
 */
function flattenOrganizedItems(items: OrganizedItem[]): OrganizedItem[] {
  return items.reduce((flat: OrganizedItem[], item) => {
    return [...flat, item, ...flattenOrganizedItems(item.children)]
  }, [])
}

function NavigationLoading() {
  return (
    <div className="space-y-6">
      <div className="mb-6">
        <PageBranding />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <Card>
        <CardContent className="space-y-2 pt-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    </div>
  )
}

function NavigationHeader({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mb-6">
      <PageBranding />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-900">
            <Navigation className="h-5 w-5" />
            Navigation Structure
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag and drop items to reorder them within their parent groups
          </p>
        </div>
        <Button onClick={onAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add Navigation Item
        </Button>
      </div>
    </div>
  )
}

function NavigationTree({
  items,
  organizedItems,
  flattenedItems,
  collapsedSections,
  activeId,
  sensors,
  onAdd,
  onDragStart,
  onDragEnd,
  onUpdate,
  onToggleSection,
}: {
  items: SelectNavigationItem[]
  organizedItems: OrganizedItem[]
  flattenedItems: OrganizedItem[]
  collapsedSections: Set<number>
  activeId: number | null
  sensors: ReturnType<typeof useSensors>
  onAdd: () => void
  onDragStart: (event: DragStartEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onUpdate: () => void
  onToggleSection: (id: number) => void
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Navigation className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <p className="mb-4 text-muted-foreground">No navigation items yet</p>
          <Button onClick={onAdd} variant="secondary">
            <Plus className="mr-2 h-4 w-4" />
            Create your first navigation item
          </Button>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent className="pt-6">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={flattenedItems.map((item) => String(item.id))}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {flattenedItems.map((item) => {
                const parentCollapsed = Boolean(
                  item.parentId && collapsedSections.has(item.parentId)
                )
                return (
                  <div
                    key={item.id}
                    className="transition-all duration-200"
                    style={{
                      paddingLeft: `${item.level * 2}rem`,
                      opacity: parentCollapsed ? 0 : 1,
                      height: parentCollapsed ? 0 : "auto",
                      overflow: "hidden",
                    }}
                  >
                    <NavigationItem
                      item={item}
                      onUpdate={onUpdate}
                      isCollapsed={
                        item.type === "section" &&
                        collapsedSections.has(item.id)
                      }
                      onToggleCollapse={() =>
                        item.type === "section" && onToggleSection(item.id)
                      }
                      hasChildren={organizedItems.some(
                        (organized) =>
                          organized.id === item.id &&
                          organized.children.length > 0
                      )}
                    />
                  </div>
                )
              })}
            </div>
          </SortableContext>
          <DragOverlay>
            {activeId ? (
              <div className="rounded-lg border-2 border-primary bg-background p-4 opacity-90 shadow-xl">
                <div className="flex items-center gap-2">
                  <Navigation className="h-4 w-4" />
                  {items.find((item) => item.id === activeId)?.label}
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </CardContent>
    </Card>
  )
}

/**
 * Navigation Manager Component
 * 
 * Provides a drag-and-drop interface for managing navigation items with features:
 * - Hierarchical organization with sections and child items
 * - Collapsible sections for better organization
 * - Position management within parent groups
 * - Real-time updates to the database
 */
export function NavigationManager() {
  const [items, setItems] = useState<SelectNavigationItem[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // Configure drag sensor with a minimum distance to prevent accidental drags
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )

  // Fetch initial navigation items
  useEffect(() => {
    const abortController = new AbortController()
    
    const fetchNavigation = async () => {
      try {
        setError(null)
        const response = await fetch("/api/admin/navigation", {
          signal: abortController.signal
        })
        const data = await response.json()
        if (data.isSuccess) {
          setItems(data.data)
        } else {
          setError(data.message || "Failed to fetch navigation items")
        }
      } catch (error) {
        // Don't set error if the request was aborted
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        setError("Failed to fetch navigation items")
      } finally {
        setIsLoading(false)
      }
    }

    fetchNavigation()
    
    return () => {
      abortController.abort()
    }
  }, [])

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(Number(event.active.id))
  }

  /**
   * Handles the end of a drag operation
   * - Updates positions of items within the same parent group
   * - Uses increments of 10 for positions to allow for future insertions
   * - Maintains parent-child relationships
   */
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((item) => item.id === Number(active.id))
      const newIndex = items.findIndex((item) => item.id === Number(over.id))

      // Get the dragged item and its parent ID
      const draggedItem = items[oldIndex]
      const targetItem = items[newIndex]
      
      // Only allow reordering within the same parent group
      if (draggedItem.parentId !== targetItem.parentId) {
        return;
      }

      const newItems = arrayMove(items, oldIndex, newIndex)
      setItems(newItems)
      
      try {
        // Get all items with the same parent
        const siblingItems = newItems.filter(item => 
          item.parentId === draggedItem.parentId
        )

        // Update positions for all items in the same group
        const updates = siblingItems.map((item, index) => 
          fetch('/api/admin/navigation', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              id: item.id,
              position: index * 10
            }),
          }).then(res => res.json())
        )
        
        await Promise.all(updates)

        // Refresh the list to ensure we have the latest data
        const response = await fetch("/api/admin/navigation")
        const data = await response.json()
        if (data.isSuccess) {
          setItems(data.data)
        }
      } catch {
        setError("Failed to update item positions")
        // Revert the optimistic update
        setItems(items)
      }
    }

    setActiveId(null)
  }

  /**
   * Refreshes the navigation items list after form submission
   */
  const handleFormSubmit = async () => {
    const response = await fetch("/api/admin/navigation")
    const data = await response.json()
    if (data.isSuccess) {
      setItems(data.data)
      setError(null)
    }
    setIsFormOpen(false)
  }

  /**
   * Toggles the collapsed state of a section
   */
  const toggleSection = (sectionId: number) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
      } else {
        next.add(sectionId)
      }
      return next
    })
  }

  if (isLoading) {
    return <NavigationLoading />
  }

  // Organize items hierarchically for admin display (do not filter out any items)
  const organizedItems = organizeItems(items)
  const flattenedItems = flattenOrganizedItems(organizedItems)

  return (
    <div className="space-y-6">
      <NavigationHeader onAdd={() => setIsFormOpen(true)} />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <NavigationTree
        items={items}
        organizedItems={organizedItems}
        flattenedItems={flattenedItems}
        collapsedSections={collapsedSections}
        activeId={activeId}
        sensors={sensors}
        onAdd={() => setIsFormOpen(true)}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onUpdate={handleFormSubmit}
        onToggleSection={toggleSection}
      />

      <NavigationItemForm 
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        onSubmit={handleFormSubmit}
        items={items}
      />
    </div>
  )
}
