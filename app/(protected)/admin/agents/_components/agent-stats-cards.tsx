"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  IconMessage,
  IconUsers,
  IconClock,
  IconShield,
  IconThumbUp,
  IconActivity,
} from "@tabler/icons-react"
import type { AgentTelemetryStats } from "@/actions/admin/agent-telemetry.actions"

interface StatCardProps {
  label: string
  value: number | string
  subValue?: string
  icon: React.ReactNode
}

function StatCard({ label, value, subValue, icon }: StatCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground font-medium">{label}</p>
            <p className="text-2xl font-bold mt-1">
              {typeof value === "string" ? value : value.toLocaleString()}
            </p>
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

interface AgentStatsCardsProps {
  stats: AgentTelemetryStats | null
  loading?: boolean
}

export function AgentStatsCards({ stats, loading = false }: AgentStatsCardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    )
  }

  if (!stats) return null

  const positivePercent =
    stats.totalFeedback > 0
      ? `${Math.round(stats.positiveRate * 100)}%`
      : "N/A"

  const cards = [
    {
      label: "Total Messages",
      value: stats.totalMessages,
      subValue: `${stats.messages24h} today, ${stats.messages7d} this week`,
      icon: <IconMessage className="h-5 w-5 text-blue-600" />,
    },
    {
      label: "Active Users (7d)",
      value: stats.activeUsers7d,
      icon: <IconUsers className="h-5 w-5 text-orange-600" />,
    },
    {
      label: "Sessions",
      value: stats.totalSessions,
      icon: <IconActivity className="h-5 w-5 text-emerald-600" />,
    },
    {
      label: "Avg Latency",
      value: stats.avgLatencyMs > 1000
        ? `${(stats.avgLatencyMs / 1000).toFixed(1)}s`
        : `${stats.avgLatencyMs}ms`,
      icon: <IconClock className="h-5 w-5 text-purple-600" />,
    },
    {
      label: "Guardrail Flags",
      value: stats.guardrailFlags,
      subValue: "telemetry-only, no blocking",
      icon: <IconShield className="h-5 w-5 text-red-600" />,
    },
    {
      label: "Feedback",
      value: `${stats.totalFeedback} (${positivePercent} positive)`,
      icon: <IconThumbUp className="h-5 w-5 text-green-600" />,
    },
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {cards.map((card) => (
        <StatCard
          key={card.label}
          label={card.label}
          value={card.value}
          subValue={card.subValue}
          icon={card.icon}
        />
      ))}
    </div>
  )
}
