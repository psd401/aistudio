"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Role configuration with colors for each database role.
 *
 * Displays the actual database role names (administrator, staff, student, etc.)
 * with color-coded badges for visual differentiation.
 */
const ROLE_CONFIG: Record<string, { className: string }> = {
  administrator: {
    className: "bg-blue-100 text-blue-800 hover:bg-blue-100"
  },
  staff: {
    className: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
  },
  student: {
    className: "bg-gray-100 text-gray-800 hover:bg-gray-100"
  },
  "prompt-engineer": {
    className: "bg-purple-100 text-purple-800 hover:bg-purple-100"
  }
}

interface RoleBadgeProps {
  role: string
  className?: string
}

export function RoleBadge({ role, className }: RoleBadgeProps) {
  const config = ROLE_CONFIG[role.toLowerCase()]
  const badgeClassName = config?.className || "bg-gray-100 text-gray-800"

  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-xs font-medium px-2 py-0.5 rounded-full",
        badgeClassName,
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
