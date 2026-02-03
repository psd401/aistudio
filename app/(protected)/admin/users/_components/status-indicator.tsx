"use client"

import { cn } from "@/lib/utils"

export type UserStatus = "active" | "inactive" | "pending"

interface StatusIndicatorProps {
  status: UserStatus
  showLabel?: boolean
  size?: "sm" | "md"
  className?: string
}

const statusConfig: Record<UserStatus, { color: string; label: string }> = {
  active: {
    color: "bg-emerald-500",
    label: "Active"
  },
  inactive: {
    color: "bg-gray-400",
    label: "Inactive"
  },
  pending: {
    color: "bg-yellow-500",
    label: "Pending"
  }
}

const sizeClasses = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5"
}

export function StatusIndicator({
  status,
  showLabel = true,
  size = "md",
  className
}: StatusIndicatorProps) {
  const config = statusConfig[status]

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className={cn(
          "rounded-full flex-shrink-0",
          config.color,
          sizeClasses[size]
        )}
        aria-hidden="true"
      />
      {showLabel && (
        <span className="text-sm capitalize">{config.label}</span>
      )}
      <span className="sr-only">Status: {config.label}</span>
    </div>
  )
}
