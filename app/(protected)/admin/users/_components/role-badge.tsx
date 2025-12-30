"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// Role configuration with colors matching the mockup design
const ROLE_CONFIG: Record<string, { label: string; className: string }> = {
  administrator: {
    label: "Admin",
    className: "bg-blue-100 text-blue-800 hover:bg-blue-100"
  },
  staff: {
    label: "Editor",
    className: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
  },
  student: {
    label: "Viewer",
    className: "bg-gray-100 text-gray-800 hover:bg-gray-100"
  },
  // Additional roles for extensibility
  "prompt-engineer": {
    label: "Prompt Eng",
    className: "bg-purple-100 text-purple-800 hover:bg-purple-100"
  }
}

interface RoleBadgeProps {
  role: string
  className?: string
}

export function RoleBadge({ role, className }: RoleBadgeProps) {
  const config = ROLE_CONFIG[role.toLowerCase()] || {
    label: role,
    className: "bg-gray-100 text-gray-800"
  }

  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-xs font-medium px-2 py-0.5 rounded-full",
        config.className,
        className
      )}
    >
      {config.label}
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
