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
        <CardContent>
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
      <CardContent>
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
  /** Currently applied provider filter ("all" when unfiltered). */
  activeProvider?: string
  /** Click a provider chip to filter the table; clicking the active one clears it. */
  onProviderSelect?: (provider: string) => void
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

export function StatsCards({ stats, loading = false, className, activeProvider, onProviderSelect }: StatsCardsProps) {
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
      icon: <IconMessage className="h-5 w-5 text-[var(--mer-brand-mid)]" />,
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

      {/* Provider breakdown. Card already supplies p-6, and CardContent adds its
          own mt-4 — the old `py-4` on top of both left a large gap above the
          label. mt-0 lets Card's padding stand alone. */}
      {!loading && Object.keys(stats.byProvider).length > 0 && (
        <Card className="p-4">
          <CardContent className="mt-0">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2.5">
              By Provider
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.byProvider).map(([provider, count]) => {
                const active = activeProvider === provider
                return (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => onProviderSelect?.(active ? "all" : provider)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors",
                      active
                        ? "bg-[var(--mer-brand)] text-white border-[var(--mer-brand)]"
                        : "bg-muted border-transparent hover:border-[var(--mer-ink-muted)]"
                    )}
                  >
                    {getProviderIcon(provider)}
                    <span className="font-medium">{provider}</span>
                    <span className={active ? "opacity-80" : "text-muted-foreground"}>
                      ({count})
                    </span>
                  </button>
                )
              })}
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
