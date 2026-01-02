"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  IconBrain,
  IconCheck,
  IconMessage,
  IconBrandOpenai,
  IconBrandAws,
  IconBrandGoogle,
  IconBrandAzure,
} from "@tabler/icons-react"
import { cn } from "@/lib/utils"

interface StatCardProps {
  label: string
  value: number | string
  icon: React.ReactNode
  loading?: boolean
  className?: string
}

function StatCard({ label, value, icon, loading, className }: StatCardProps) {
  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
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
              {typeof value === "number" ? value.toLocaleString() : value}
            </p>
          </div>
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export interface ModelStats {
  totalModels: number
  activeModels: number
  nexusEnabled: number
  byProvider: Record<string, number>
}

interface StatsCardsProps {
  stats: ModelStats
  loading?: boolean
  className?: string
}

// Provider icon mapping
function getProviderIcon(provider: string) {
  const normalized = provider.toLowerCase()
  if (normalized.includes("openai")) {
    return <IconBrandOpenai className="h-4 w-4" />
  }
  if (normalized.includes("bedrock") || normalized.includes("amazon")) {
    return <IconBrandAws className="h-4 w-4" />
  }
  if (normalized.includes("google") || normalized.includes("vertex")) {
    return <IconBrandGoogle className="h-4 w-4" />
  }
  if (normalized.includes("azure")) {
    return <IconBrandAzure className="h-4 w-4" />
  }
  return <IconBrain className="h-4 w-4" />
}

export function StatsCards({ stats, loading = false, className }: StatsCardsProps) {
  const cards = [
    {
      label: "Total Models",
      value: stats.totalModels,
      icon: <IconBrain className="h-5 w-5 text-blue-600" />,
    },
    {
      label: "Active Models",
      value: stats.activeModels,
      icon: <IconCheck className="h-5 w-5 text-emerald-600" />,
    },
    {
      label: "Nexus Enabled",
      value: stats.nexusEnabled,
      icon: <IconMessage className="h-5 w-5 text-purple-600" />,
    },
  ]

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            icon={card.icon}
            loading={loading}
          />
        ))}
      </div>

      {/* Provider breakdown */}
      {!loading && Object.keys(stats.byProvider).length > 0 && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm text-muted-foreground font-medium mb-2">By Provider</p>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.byProvider).map(([provider, count]) => (
                <div
                  key={provider}
                  className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-sm"
                >
                  {getProviderIcon(provider)}
                  <span className="font-medium">{provider}</span>
                  <span className="text-muted-foreground">({count})</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function StatsCardsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-16 w-full" />
    </div>
  )
}
