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
import { PROVIDER_OPTIONS } from "./provider-badge"

export type ModelStatus = "all" | "active" | "inactive"
export type AvailabilityFilter = "all" | "nexus" | "architect"

export interface ModelFiltersState {
  search: string
  status: ModelStatus
  provider: string
  availability: AvailabilityFilter
}

interface ModelFiltersProps {
  onFiltersChange: (filters: ModelFiltersState) => void
  initialFilters?: Partial<ModelFiltersState>
  className?: string
}

const STATUS_OPTIONS: Array<{ value: ModelStatus; label: string }> = [
  { value: "all", label: "All Status" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
]

const AVAILABILITY_OPTIONS: Array<{ value: AvailabilityFilter; label: string }> = [
  { value: "all", label: "All Features" },
  { value: "nexus", label: "Nexus Enabled" },
  { value: "architect", label: "Architect Enabled" },
]

export function ModelFilters({
  onFiltersChange,
  initialFilters,
  className,
}: ModelFiltersProps) {
  const [search, setSearch] = useState(initialFilters?.search || "")
  const [status, setStatus] = useState<ModelStatus>(initialFilters?.status || "all")
  const [provider, setProvider] = useState(initialFilters?.provider || "all")
  const [availability, setAvailability] = useState<AvailabilityFilter>(
    initialFilters?.availability || "all"
  )

  const [debouncedSearch] = useDebounce(search, 300)

  // Notify parent when debounced search changes
  const notifyChange = useCallback(
    (newFilters: Partial<ModelFiltersState>) => {
      onFiltersChange({
        search: newFilters.search ?? debouncedSearch,
        status: newFilters.status ?? status,
        provider: newFilters.provider ?? provider,
        availability: newFilters.availability ?? availability,
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedSearch, status, provider, availability]
  )

  // Handle search input
  const handleSearchChange = (value: string) => {
    setSearch(value)
  }

  // Notify parent when debounced search changes
  useEffect(() => {
    notifyChange({ search: debouncedSearch })
  }, [debouncedSearch, notifyChange])

  // Handle status change (immediate)
  const handleStatusChange = (value: ModelStatus) => {
    setStatus(value)
    notifyChange({ status: value })
  }

  // Handle provider change (immediate)
  const handleProviderChange = (value: string) => {
    setProvider(value)
    notifyChange({ provider: value })
  }

  // Handle availability change (immediate)
  const handleAvailabilityChange = (value: AvailabilityFilter) => {
    setAvailability(value)
    notifyChange({ availability: value })
  }

  // Clear all filters
  const handleClearFilters = () => {
    setSearch("")
    setStatus("all")
    setProvider("all")
    setAvailability("all")
    onFiltersChange({
      search: "",
      status: "all",
      provider: "all",
      availability: "all",
    })
  }

  const hasActiveFilters =
    search !== "" || status !== "all" || provider !== "all" || availability !== "all"

  return (
    <div className={cn("flex flex-col sm:flex-row gap-3", className)}>
      {/* Search Input */}
      <div className="relative flex-1 min-w-0">
        <Input
          placeholder="Search models by name or ID..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          icon={<IconSearch className="h-4 w-4" />}
          className="w-full"
          aria-label="Search models"
        />
      </div>

      {/* Status Filter */}
      <Select value={status} onValueChange={handleStatusChange}>
        <SelectTrigger className="w-full sm:w-[140px]" aria-label="Filter by status">
          <SelectValue placeholder="All Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Provider Filter */}
      <Select value={provider} onValueChange={handleProviderChange}>
        <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filter by provider">
          <SelectValue placeholder="All Providers" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Providers</SelectItem>
          {PROVIDER_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Availability Filter */}
      <Select value={availability} onValueChange={handleAvailabilityChange}>
        <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filter by availability">
          <SelectValue placeholder="All Features" />
        </SelectTrigger>
        <SelectContent>
          {AVAILABILITY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear Filters Button */}
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

// Hook for managing filter state
export function useModelFilters(initialFilters?: Partial<ModelFiltersState>) {
  const [filters, setFilters] = useState<ModelFiltersState>({
    search: initialFilters?.search || "",
    status: initialFilters?.status || "all",
    provider: initialFilters?.provider || "all",
    availability: initialFilters?.availability || "all",
  })

  return {
    filters,
    setFilters,
    clearFilters: () =>
      setFilters({
        search: "",
        status: "all",
        provider: "all",
        availability: "all",
      }),
  }
}
