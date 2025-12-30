"use client"

import { useState, useCallback, useEffect } from "react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { IconSearch, IconX } from "@tabler/icons-react"
import { useDebounce } from "use-debounce"
import { cn } from "@/lib/utils"

export type UserStatus = "all" | "active" | "inactive" | "pending"

export interface UserFiltersState {
  search: string
  status: UserStatus
  role: string
}

interface UserFiltersProps {
  roles: Array<{ id: string; name: string }>
  onFiltersChange: (filters: UserFiltersState) => void
  initialFilters?: Partial<UserFiltersState>
  className?: string
}

const STATUS_OPTIONS: Array<{ value: UserStatus; label: string }> = [
  { value: "all", label: "All Statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "pending", label: "Pending" }
]

export function UserFilters({
  roles,
  onFiltersChange,
  initialFilters,
  className
}: UserFiltersProps) {
  const [search, setSearch] = useState(initialFilters?.search || "")
  const [status, setStatus] = useState<UserStatus>(initialFilters?.status || "all")
  const [role, setRole] = useState(initialFilters?.role || "all")

  const [debouncedSearch] = useDebounce(search, 300)

  // Notify parent when debounced search changes
  const notifyChange = useCallback(
    (newFilters: Partial<UserFiltersState>) => {
      onFiltersChange({
        search: newFilters.search ?? debouncedSearch,
        status: newFilters.status ?? status,
        role: newFilters.role ?? role
      })
    },
    [debouncedSearch, status, role, onFiltersChange]
  )

  // Handle search input
  const handleSearchChange = (value: string) => {
    setSearch(value)
    // Debounced value will trigger useEffect below
  }

  // Notify parent when debounced search changes
  useEffect(() => {
    notifyChange({ search: debouncedSearch })
  }, [debouncedSearch, notifyChange])

  // Handle status change (immediate)
  const handleStatusChange = (value: UserStatus) => {
    setStatus(value)
    notifyChange({ status: value })
  }

  // Handle role change (immediate)
  const handleRoleChange = (value: string) => {
    setRole(value)
    notifyChange({ role: value })
  }

  // Clear all filters
  const handleClearFilters = () => {
    setSearch("")
    setStatus("all")
    setRole("all")
    onFiltersChange({ search: "", status: "all", role: "all" })
  }

  const hasActiveFilters = search !== "" || status !== "all" || role !== "all"

  return (
    <div className={cn("flex flex-col sm:flex-row gap-3", className)}>
      {/* Search Input */}
      <div className="relative flex-1 min-w-0">
        <Input
          placeholder="Search users by name or email..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          icon={<IconSearch className="h-4 w-4" />}
          className="w-full"
          aria-label="Search users"
        />
      </div>

      {/* Status Filter */}
      <Select value={status} onValueChange={handleStatusChange}>
        <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filter by status">
          <SelectValue placeholder="All Statuses" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Role Filter */}
      <Select value={role} onValueChange={handleRoleChange}>
        <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filter by role">
          <SelectValue placeholder="All Roles" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Roles</SelectItem>
          {roles.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.name}
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

// Hook for managing filter state with URL sync (optional enhancement)
export function useUserFilters(initialFilters?: Partial<UserFiltersState>) {
  const [filters, setFilters] = useState<UserFiltersState>({
    search: initialFilters?.search || "",
    status: initialFilters?.status || "all",
    role: initialFilters?.role || "all"
  })

  return {
    filters,
    setFilters,
    clearFilters: () => setFilters({ search: "", status: "all", role: "all" })
  }
}
