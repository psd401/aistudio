"use client"

import { useState, useCallback, useEffect } from "react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { IconSearch, IconX } from "@tabler/icons-react"
import { useDebounce } from "use-debounce"
import { cn } from "@/lib/utils"

// ============================================
// Node Filters
// ============================================

export interface NodeFiltersState {
  search: string
  nodeType: string
  nodeClass: string
}

interface NodeFiltersProps {
  onFiltersChange: (filters: NodeFiltersState) => void
  initialFilters?: Partial<NodeFiltersState>
  nodeTypes: string[]
  nodeClasses: string[]
  className?: string
}

export function NodeFilters({
  onFiltersChange,
  initialFilters,
  nodeTypes,
  nodeClasses,
  className,
}: NodeFiltersProps) {
  const [search, setSearch] = useState(initialFilters?.search || "")
  const [nodeType, setNodeType] = useState(initialFilters?.nodeType || "all")
  const [nodeClass, setNodeClass] = useState(
    initialFilters?.nodeClass || "all"
  )

  const [debouncedSearch] = useDebounce(search, 300)

  const notifyChange = useCallback(
    (newFilters: Partial<NodeFiltersState>) => {
      onFiltersChange({
        search: newFilters.search ?? debouncedSearch,
        nodeType: newFilters.nodeType ?? nodeType,
        nodeClass: newFilters.nodeClass ?? nodeClass,
      })
    },
    [debouncedSearch, nodeType, nodeClass, onFiltersChange]
  )

  useEffect(() => {
    notifyChange({ search: debouncedSearch })
  }, [debouncedSearch, notifyChange])

  const handleNodeTypeChange = (value: string) => {
    setNodeType(value)
    notifyChange({ nodeType: value })
  }

  const handleNodeClassChange = (value: string) => {
    setNodeClass(value)
    notifyChange({ nodeClass: value })
  }

  const handleClearFilters = () => {
    setSearch("")
    setNodeType("all")
    setNodeClass("all")
    onFiltersChange({ search: "", nodeType: "all", nodeClass: "all" })
  }

  const hasActiveFilters =
    search !== "" || nodeType !== "all" || nodeClass !== "all"

  return (
    <div className={cn("flex flex-col sm:flex-row gap-3", className)}>
      <div className="relative flex-1 min-w-0">
        <Input
          placeholder="Search nodes by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          icon={<IconSearch className="h-4 w-4" />}
          className="w-full"
          aria-label="Search nodes"
        />
      </div>

      <Select value={nodeType} onValueChange={handleNodeTypeChange}>
        <SelectTrigger
          className="w-full sm:w-[160px]"
          aria-label="Filter by node type"
        >
          <SelectValue placeholder="All Types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Types</SelectItem>
          {nodeTypes.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={nodeClass} onValueChange={handleNodeClassChange}>
        <SelectTrigger
          className="w-full sm:w-[160px]"
          aria-label="Filter by node class"
        >
          <SelectValue placeholder="All Classes" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Classes</SelectItem>
          {nodeClasses.map((cls) => (
            <SelectItem key={cls} value={cls}>
              {cls}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearFilters}
          className="h-9 px-3 text-muted-foreground hover:text-foreground"
          aria-label="Clear all filters"
        >
          <IconX className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  )
}

// ============================================
// Edge Filters
// ============================================

export interface EdgeFiltersState {
  edgeType: string
}

interface EdgeFiltersProps {
  onFiltersChange: (filters: EdgeFiltersState) => void
  initialFilters?: Partial<EdgeFiltersState>
  edgeTypes: string[]
  className?: string
}

export function EdgeFilters({
  onFiltersChange,
  initialFilters,
  edgeTypes,
  className,
}: EdgeFiltersProps) {
  const [edgeType, setEdgeType] = useState(
    initialFilters?.edgeType || "all"
  )

  const handleEdgeTypeChange = (value: string) => {
    setEdgeType(value)
    onFiltersChange({ edgeType: value })
  }

  const handleClearFilters = () => {
    setEdgeType("all")
    onFiltersChange({ edgeType: "all" })
  }

  const hasActiveFilters = edgeType !== "all"

  return (
    <div className={cn("flex flex-col sm:flex-row gap-3", className)}>
      <Select value={edgeType} onValueChange={handleEdgeTypeChange}>
        <SelectTrigger
          className="w-full sm:w-[200px]"
          aria-label="Filter by edge type"
        >
          <SelectValue placeholder="All Edge Types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Edge Types</SelectItem>
          {edgeTypes.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearFilters}
          className="h-9 px-3 text-muted-foreground hover:text-foreground"
          aria-label="Clear all filters"
        >
          <IconX className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  )
}
