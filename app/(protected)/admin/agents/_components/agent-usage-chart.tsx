"use client"

import { useMemo } from "react"
import dynamic from "next/dynamic"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DailyUsagePoint } from "@/actions/admin/agent-telemetry.actions"

// Lazy-load Recharts to reduce initial bundle size
const LazyResponsiveContainer = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.ResponsiveContainer })),
  { ssr: false }
)
const LazyAreaChart = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.AreaChart })),
  { ssr: false }
)
const LazyArea = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.Area })),
  { ssr: false }
)
const LazyXAxis = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.XAxis })),
  { ssr: false }
)
const LazyYAxis = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.YAxis })),
  { ssr: false }
)
const LazyCartesianGrid = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.CartesianGrid })),
  { ssr: false }
)
const LazyTooltip = dynamic(
  () => import("recharts").then((mod) => ({ default: mod.Tooltip })),
  { ssr: false }
)

interface AgentUsageChartProps {
  data: DailyUsagePoint[]
  loading?: boolean
}

export function AgentUsageChart({ data, loading = false }: AgentUsageChartProps) {
  const formattedData = useMemo(() => {
    return data.map((d) => ({
      ...d,
      // Shorten "2026-04-22" to "Apr 22"
      label: new Date(d.date + "T00:00:00Z").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    }))
  }, [data])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Message Volume</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (formattedData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Message Volume</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 flex items-center justify-center text-muted-foreground">
            No message data available for this period
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily Message Volume</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <LazyResponsiveContainer width="100%" height="100%">
            <LazyAreaChart data={formattedData}>
              <LazyCartesianGrid strokeDasharray="3 3" />
              <LazyXAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <LazyYAxis tick={{ fontSize: 12 }} />
              <LazyTooltip
                contentStyle={{
                  backgroundColor: "white",
                  border: "1px solid #e5e7eb",
                  borderRadius: "6px",
                  fontSize: "12px",
                }}
              />
              <LazyArea
                type="monotone"
                dataKey="messages"
                stroke="#3b82f6"
                fill="#93c5fd"
                fillOpacity={0.3}
                name="Messages"
              />
              <LazyArea
                type="monotone"
                dataKey="sessions"
                stroke="#10b981"
                fill="#6ee7b7"
                fillOpacity={0.2}
                name="Sessions"
              />
            </LazyAreaChart>
          </LazyResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
