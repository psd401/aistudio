"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface RoleBadgeProps {
  role: string
  className?: string
}

/**
 * Role badge component that displays database role names
 *
 * Fully dynamic - works with any role from the roles table without code changes.
 * If you need different colors per role, add a badge_color column to the roles table.
 */
export function RoleBadge({ role, className }: RoleBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-xs font-medium px-2 py-0.5 rounded-full",
        className
      )}
    >
      {role}
    </Badge>
  )
}

interface RoleBadgeListProps {
  roles: string[]
  maxDisplay?: number
  className?: string
}

export function RoleBadgeList({ roles, maxDisplay = 2, className }: RoleBadgeListProps) {
  const displayed = roles.slice(0, maxDisplay)
  const remaining = roles.length - maxDisplay

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {displayed.map((role) => (
        <RoleBadge key={role} role={role} />
      ))}
      {remaining > 0 && (
        <Badge variant="outline" className="text-xs text-muted-foreground">
          +{remaining}
        </Badge>
      )}
    </div>
  )
}
