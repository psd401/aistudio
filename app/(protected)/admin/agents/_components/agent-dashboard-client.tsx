"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { IconRefresh } from "@tabler/icons-react"
import { PageBranding } from "@/components/ui/page-branding"

import { AgentStatsCards } from "./agent-stats-cards"
import { AgentUsageChart } from "./agent-usage-chart"
import { AgentModelBreakdown } from "./agent-model-breakdown"
import { AgentUserTable } from "./agent-user-table"
import { AgentSafetyTable } from "./agent-safety-table"
import { AgentFeedbackTable } from "./agent-feedback-table"
import { AgentHealthTable } from "./agent-health-table"
import { AgentCostView } from "./agent-cost-view"
import { AgentPatternsTable } from "./agent-patterns-table"

import {
  getAgentTelemetryStats,
  getAgentDailyUsage,
  getAgentModelBreakdown,
  getAgentUserUsage,
  getAgentGuardrailEvents,
  getAgentFeedbackList,
  type AgentTelemetryStats,
  type DailyUsagePoint,
  type ModelBreakdownItem,
  type UserUsageItem,
  type GuardrailEvent,
  type FeedbackItem,
  type TelemetryDateRange,
} from "@/actions/admin/agent-telemetry.actions"
import {
  getAgentHealthSummary,
  getAgentPatterns,
  type AgentHealthSummary,
  type AgentPatternRow,
} from "@/actions/admin/agent-health.actions"
import {
  getAgentCostSummary,
  type AgentCostSummary,
  type CostDateRange,
} from "@/actions/admin/agent-cost.actions"

type DashboardTab =
  | "usage"
  | "adoption"
  | "safety"
  | "feedback"
  | "health"
  | "cost"
  | "patterns"

function telemetryToCostRange(r: TelemetryDateRange): CostDateRange {
  // Cost Explorer supports 7/30/90d buckets only.
  return r === "7d" ? "7d" : r === "90d" ? "90d" : "30d"
}

interface LoaderSetters {
  setDailyUsage: (v: DailyUsagePoint[]) => void
  setModelBreakdown: (v: ModelBreakdownItem[]) => void
  setUserUsage: (v: UserUsageItem[]) => void
  setGuardrailEvents: (v: GuardrailEvent[]) => void
  setFeedbackList: (v: FeedbackItem[]) => void
  setHealthSummary: (v: AgentHealthSummary | null) => void
  setCostSummary: (v: AgentCostSummary | null) => void
  setPatterns: (v: AgentPatternRow[]) => void
}

function buildLoaders(s: LoaderSetters): Record<DashboardTab, (range: TelemetryDateRange) => Promise<void>> {
  return {
    usage: async (range) => {
      const [u, m] = await Promise.all([getAgentDailyUsage(range), getAgentModelBreakdown(range)])
      if (u.isSuccess && u.data) s.setDailyUsage(u.data)
      if (m.isSuccess && m.data) s.setModelBreakdown(m.data)
    },
    adoption: async (range) => {
      const r = await getAgentUserUsage(range)
      if (r.isSuccess && r.data) s.setUserUsage(r.data)
    },
    safety: async (range) => {
      const r = await getAgentGuardrailEvents(range)
      if (r.isSuccess && r.data) s.setGuardrailEvents(r.data)
    },
    feedback: async (range) => {
      const r = await getAgentFeedbackList(range)
      if (r.isSuccess && r.data) s.setFeedbackList(r.data)
    },
    health: async () => {
      const r = await getAgentHealthSummary()
      if (r.isSuccess && r.data) s.setHealthSummary(r.data)
    },
    cost: async (range) => {
      const r = await getAgentCostSummary(telemetryToCostRange(range))
      s.setCostSummary(r.isSuccess && r.data ? r.data : null)
    },
    patterns: async () => {
      const r = await getAgentPatterns()
      if (r.isSuccess && r.data) s.setPatterns(r.data)
    },
  }
}

function DashboardHeader({
  dateRange,
  onDateRangeChange,
  onRefresh,
}: {
  dateRange: TelemetryDateRange
  onDateRangeChange: (r: TelemetryDateRange) => void
  onRefresh: () => void
}) {
  return (
    <div className="mb-6">
      <PageBranding />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Agent Platform Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor agent usage, adoption, safety signals, and user feedback
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Period:</span>
            <Select
              value={dateRange}
              onValueChange={(v) => onDateRangeChange(v as TelemetryDateRange)}
            >
              <SelectTrigger className="w-[160px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_RANGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <IconRefresh className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>
    </div>
  )
}

const DATE_RANGE_OPTIONS: { value: TelemetryDateRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
]

export function AgentDashboardClient() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<DashboardTab>("usage")
  const [dateRange, setDateRange] = useState<TelemetryDateRange>("30d")
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<AgentTelemetryStats | null>(null)
  const [dailyUsage, setDailyUsage] = useState<DailyUsagePoint[]>([])
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdownItem[]>([])
  const [userUsage, setUserUsage] = useState<UserUsageItem[]>([])
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([])
  const [feedbackList, setFeedbackList] = useState<FeedbackItem[]>([])
  const [healthSummary, setHealthSummary] = useState<AgentHealthSummary | null>(null)
  const [costSummary, setCostSummary] = useState<AgentCostSummary | null>(null)
  const [patterns, setPatterns] = useState<AgentPatternRow[]>([])
  const [tabLoading, setTabLoading] = useState(false)

  const loadStats = useCallback(
    async (range: TelemetryDateRange) => {
      const result = await getAgentTelemetryStats(range)
      if (result.isSuccess && result.data) {
        setStats(result.data)
      } else {
        toast({
          variant: "destructive",
          title: "Error loading stats",
          description: result.message,
        })
      }
    },
    [toast]
  )

  // useState setters are stable so `[]` deps is safe.
  const loaders = useMemo(
    () => buildLoaders({
      setDailyUsage, setModelBreakdown, setUserUsage, setGuardrailEvents,
      setFeedbackList, setHealthSummary, setCostSummary, setPatterns,
    }),
    []
  )

  const loadTabData = useCallback(
    async (tab: DashboardTab, range: TelemetryDateRange) => {
      setTabLoading(true)

      try {
        await loaders[tab](range)
      } catch {
        toast({
          variant: "destructive",
          title: "Error loading data",
          description: "Failed to load tab data",
        })
      }

      setTabLoading(false)
    },
    [toast, loaders]
  )

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      await Promise.all([loadStats(dateRange), loadTabData(activeTab, dateRange)])
      setLoading(false)
    }
    init()
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDateRangeChange = useCallback(
    async (range: TelemetryDateRange) => {
      setDateRange(range)
      setLoading(true)
      await Promise.all([loadStats(range), loadTabData(activeTab, range)])
      setLoading(false)
    },
    [activeTab, loadStats, loadTabData]
  )

  const handleTabChange = useCallback(
    async (tab: string) => {
      const newTab = tab as DashboardTab
      setActiveTab(newTab)
      await loadTabData(newTab, dateRange)
    },
    [dateRange, loadTabData]
  )

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([loadStats(dateRange), loadTabData(activeTab, dateRange)])
    setLoading(false)
  }, [activeTab, dateRange, loadStats, loadTabData])

  return (
    <div className="p-6 space-y-6">
      <DashboardHeader
        dateRange={dateRange}
        onDateRangeChange={handleDateRangeChange}
        onRefresh={handleRefresh}
      />

      <AgentStatsCards stats={stats} loading={loading} />
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="cost">Cost</TabsTrigger>
          <TabsTrigger value="adoption">Adoption</TabsTrigger>
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="safety">Safety</TabsTrigger>
          <TabsTrigger value="patterns">Patterns</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
        </TabsList>

        <TabsContent value="usage" className="mt-4 space-y-6">
          <AgentUsageChart data={dailyUsage} loading={tabLoading} />
          <AgentModelBreakdown data={modelBreakdown} loading={tabLoading} />
        </TabsContent>

        <TabsContent value="adoption" className="mt-4">
          <AgentUserTable data={userUsage} loading={tabLoading} />
        </TabsContent>

        <TabsContent value="safety" className="mt-4">
          <AgentSafetyTable data={guardrailEvents} loading={tabLoading} />
        </TabsContent>

        <TabsContent value="feedback" className="mt-4">
          <AgentFeedbackTable data={feedbackList} loading={tabLoading} />
        </TabsContent>

        <TabsContent value="health" className="mt-4">
          <AgentHealthTable data={healthSummary} loading={tabLoading} />
        </TabsContent>

        <TabsContent value="cost" className="mt-4">
          <AgentCostView data={costSummary} loading={tabLoading} />
        </TabsContent>

        <TabsContent value="patterns" className="mt-4">
          <AgentPatternsTable data={patterns} loading={tabLoading} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
