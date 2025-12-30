"use client"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

type UserStatus = "active" | "inactive" | "pending"

interface UserAvatarProps {
  firstName: string
  lastName: string
  email?: string
  avatarUrl?: string | null
  status?: UserStatus
  size?: "sm" | "md" | "lg"
  showStatusIndicator?: boolean
  className?: string
}

const sizeClasses = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-16 w-16 text-lg"
}

const statusColors: Record<UserStatus, string> = {
  active: "bg-emerald-500",
  inactive: "bg-gray-400",
  pending: "bg-yellow-500"
}

const statusIndicatorSize = {
  sm: "h-2 w-2",
  md: "h-3 w-3",
  lg: "h-4 w-4"
}

export function UserAvatar({
  firstName,
  lastName,
  email,
  avatarUrl,
  status,
  size = "md",
  showStatusIndicator = false,
  className
}: UserAvatarProps) {
  const initials = `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase() ||
    (email?.[0]?.toUpperCase() || "?")

  return (
    <div className={cn("relative inline-block", className)}>
      <Avatar className={sizeClasses[size]}>
        {avatarUrl && <AvatarImage src={avatarUrl} alt={`${firstName} ${lastName}`} />}
        <AvatarFallback className="bg-blue-100 text-blue-900 font-semibold">
          {initials}
        </AvatarFallback>
      </Avatar>
      {showStatusIndicator && status && (
        <div
          className={cn(
            "absolute bottom-0 right-0 rounded-full border-2 border-white",
            statusColors[status],
            statusIndicatorSize[size]
          )}
          title={status}
          aria-label={`Status: ${status}`}
        />
      )}
    </div>
  )
}
