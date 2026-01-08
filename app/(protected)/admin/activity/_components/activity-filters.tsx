"use client"

import { useState, useCallback, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { IconSearch, IconX } from "@tabler/icons-react"
import type { ActivityFilters } from "@/actions/admin/activity-management.actions"

interface ActivityFiltersProps {
  onFiltersChange: (filters: ActivityFilters) => void
  loading?: boolean
}

export function ActivityFiltersComponent({
  onFiltersChange,
  loading,
}: ActivityFiltersProps) {
  const [search, setSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Apply filters when any filter changes
  useEffect(() => {
    onFiltersChange({
      search: debouncedSearch || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, dateFrom, dateTo])

  const clearFilters = useCallback(() => {
    setSearch("")
    setDateFrom("")
    setDateTo("")
  }, [])

  const hasFilters = search || dateFrom || dateTo

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Search */}
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by user, title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          disabled={loading}
        />
      </div>

      {/* Date From */}
      <Input
        type="date"
        value={dateFrom}
        onChange={(e) => setDateFrom(e.target.value)}
        className="w-[150px]"
        disabled={loading}
        placeholder="From date"
      />

      {/* Date To */}
      <Input
        type="date"
        value={dateTo}
        onChange={(e) => setDateTo(e.target.value)}
        className="w-[150px]"
        disabled={loading}
        placeholder="To date"
      />

      {/* Clear Filters */}
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          disabled={loading}
        >
          <IconX className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  )
}
