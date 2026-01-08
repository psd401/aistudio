"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  IconMessageCircle,
  IconRobot,
  IconScale,
  IconUsers,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import type { ActivityStats } from "@/actions/admin/activity-management.actions"

interface StatCardProps {
  label: string
  value: number
  subValue?: string
  icon: React.ReactNode
  loading?: boolean
  className?: string
}

function StatCard({ label, value, subValue, icon, loading, className }: StatCardProps) {
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
            <p className="text-2xl font-bold mt-1">{value.toLocaleString()}</p>
            {subValue && (
              <p className="text-xs text-muted-foreground mt-1">{subValue}</p>
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

interface ActivityStatsCardsProps {
  stats: ActivityStats | null
  loading?: boolean
  className?: string
}

export function ActivityStatsCards({
  stats,
  loading = false,
  className,
}: ActivityStatsCardsProps) {
  const cards = [
    {
      label: "Nexus Conversations",
      value: stats?.totalNexusConversations ?? 0,
      subValue: stats
        ? `${stats.nexus24h} today, ${stats.nexus7d} this week`
        : undefined,
      icon: <IconMessageCircle className="h-5 w-5 text-blue-600" />,
    },
    {
      label: "Architect Executions",
      value: stats?.totalArchitectExecutions ?? 0,
      subValue: stats
        ? `${stats.executions24h} today, ${stats.executions7d} this week`
        : undefined,
      icon: <IconRobot className="h-5 w-5 text-purple-600" />,
    },
    {
      label: "Model Comparisons",
      value: stats?.totalComparisons ?? 0,
      subValue: stats
        ? `${stats.comparisons24h} today, ${stats.comparisons7d} this week`
        : undefined,
      icon: <IconScale className="h-5 w-5 text-emerald-600" />,
    },
    {
      label: "Active Users (7d)",
      value: stats?.activeUsers7d ?? 0,
      icon: <IconUsers className="h-5 w-5 text-orange-600" />,
    },
  ]

  return (
    <div
      className={cn(
        "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4",
        className
      )}
    >
      {cards.map((card) => (
        <StatCard
          key={card.label}
          label={card.label}
          value={card.value}
          subValue={card.subValue}
          icon={card.icon}
          loading={loading}
        />
      ))}
    </div>
  )
}

export function ActivityStatsCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  )
}
