"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { IconUsers, IconUserCheck, IconMail, IconShield } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import type { UserStats } from "@/actions/admin/user-management.actions"

interface StatCardProps {
  label: string
  value: number
  icon: React.ReactNode
  trend?: {
    value: number
    isPositive: boolean
  }
  loading?: boolean
  className?: string
}

function StatCard({ label, value, icon, trend, loading, className }: StatCardProps) {
  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-10 w-10 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground font-medium">{label}</p>
            <p className="text-2xl font-bold mt-1">
              {value.toLocaleString()}
            </p>
            {trend && (
              <p
                className={cn(
                  "text-xs mt-1 font-medium",
                  trend.isPositive ? "text-emerald-600" : "text-red-600"
                )}
              >
                {trend.isPositive ? "+" : ""}{trend.value}% from last month
              </p>
            )}
          </div>
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

interface StatsCardsProps {
  stats: UserStats
  loading?: boolean
  className?: string
}

export function StatsCards({ stats, loading = false, className }: StatsCardsProps) {
  const cards = [
    {
      label: "Total Users",
      value: stats.totalUsers,
      icon: <IconUsers className="h-5 w-5 text-blue-600" />,
      trend: stats.trends?.totalUsers
        ? { value: stats.trends.totalUsers, isPositive: stats.trends.totalUsers > 0 }
        : undefined
    },
    {
      label: "Active Now",
      value: stats.activeNow,
      icon: <IconUserCheck className="h-5 w-5 text-emerald-600" />,
      trend: stats.trends?.activeNow
        ? { value: stats.trends.activeNow, isPositive: stats.trends.activeNow > 0 }
        : undefined
    },
    {
      label: "Pending Invites",
      value: stats.pendingInvites,
      icon: <IconMail className="h-5 w-5 text-yellow-600" />,
      trend: undefined // Pending invites don't need trends
    },
    {
      label: "Admins",
      value: stats.admins,
      icon: <IconShield className="h-5 w-5 text-purple-600" />,
      trend: undefined
    }
  ]

  return (
    <div className={cn("grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4", className)}>
      {cards.map((card) => (
        <StatCard
          key={card.label}
          label={card.label}
          value={card.value}
          icon={card.icon}
          trend={card.trend}
          loading={loading}
        />
      ))}
    </div>
  )
}

export function StatsCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  )
}
