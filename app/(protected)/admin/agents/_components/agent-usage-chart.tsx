"use client"

import { useMemo } from "react"
import dynamic from "next/dynamic"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DailyUsagePoint } from "@/actions/admin/agent-telemetry.actions"

// Lazy-load Recharts in a single dynamic import to avoid 7 separate chunk boundaries
const LazyChart = dynamic(
  () =>
    import("recharts").then((mod) => ({
      default: ({
        data,
      }: {
        data: Array<DailyUsagePoint & { label: string }>
      }) => (
        <mod.ResponsiveContainer width="100%" height="100%">
          <mod.AreaChart data={data}>
            <mod.CartesianGrid strokeDasharray="3 3" />
            <mod.XAxis
              dataKey="label"
              tick={{ fontSize: 12 }}
              interval="preserveStartEnd"
            />
            <mod.YAxis tick={{ fontSize: 12 }} />
            <mod.Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
                fontSize: "12px",
              }}
            />
            <mod.Area
              type="monotone"
              dataKey="messages"
              stroke="#3b82f6"
              fill="#93c5fd"
              fillOpacity={0.3}
              name="Messages"
            />
            <mod.Area
              type="monotone"
              dataKey="sessions"
              stroke="#10b981"
              fill="#6ee7b7"
              fillOpacity={0.2}
              name="Sessions"
            />
          </mod.AreaChart>
        </mod.ResponsiveContainer>
      ),
    })),
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
          <LazyChart data={formattedData} />
        </div>
      </CardContent>
    </Card>
  )
}
