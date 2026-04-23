"use client"

import { useState, useEffect, useCallback } from "react"
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

type DashboardTab = "usage" | "adoption" | "safety" | "feedback"

const DATE_RANGE_OPTIONS: { value: TelemetryDateRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
]

export function AgentDashboardClient() {
  const { toast } = useToast()

  // Global state
  const [activeTab, setActiveTab] = useState<DashboardTab>("usage")
  const [dateRange, setDateRange] = useState<TelemetryDateRange>("30d")
  const [loading, setLoading] = useState(true)

  // Data state
  const [stats, setStats] = useState<AgentTelemetryStats | null>(null)
  const [dailyUsage, setDailyUsage] = useState<DailyUsagePoint[]>([])
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdownItem[]>([])
  const [userUsage, setUserUsage] = useState<UserUsageItem[]>([])
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([])
  const [feedbackList, setFeedbackList] = useState<FeedbackItem[]>([])

  // Tab-level loading
  const [tabLoading, setTabLoading] = useState(false)

  // Load stats (always shown)
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

  // Load tab-specific data
  const loadTabData = useCallback(
    async (tab: DashboardTab, range: TelemetryDateRange) => {
      setTabLoading(true)

      try {
        switch (tab) {
          case "usage": {
            const [usageResult, modelResult] = await Promise.all([
              getAgentDailyUsage(range),
              getAgentModelBreakdown(range),
            ])
            if (usageResult.isSuccess && usageResult.data) {
              setDailyUsage(usageResult.data)
            }
            if (modelResult.isSuccess && modelResult.data) {
              setModelBreakdown(modelResult.data)
            }
            break
          }
          case "adoption": {
            const userResult = await getAgentUserUsage(range)
            if (userResult.isSuccess && userResult.data) {
              setUserUsage(userResult.data)
            }
            break
          }
          case "safety": {
            const safetyResult = await getAgentGuardrailEvents(range)
            if (safetyResult.isSuccess && safetyResult.data) {
              setGuardrailEvents(safetyResult.data)
            }
            break
          }
          case "feedback": {
            const fbResult = await getAgentFeedbackList(range)
            if (fbResult.isSuccess && fbResult.data) {
              setFeedbackList(fbResult.data)
            }
            break
          }
        }
      } catch {
        toast({
          variant: "destructive",
          title: "Error loading data",
          description: "Failed to load tab data",
        })
      }

      setTabLoading(false)
    },
    [toast]
  )

  // Initial load
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

  // Handle date range change
  const handleDateRangeChange = useCallback(
    async (range: TelemetryDateRange) => {
      setDateRange(range)
      setLoading(true)
      await Promise.all([loadStats(range), loadTabData(activeTab, range)])
      setLoading(false)
    },
    [activeTab, loadStats, loadTabData]
  )

  // Handle tab change
  const handleTabChange = useCallback(
    async (tab: string) => {
      const newTab = tab as DashboardTab
      setActiveTab(newTab)
      await loadTabData(newTab, dateRange)
    },
    [dateRange, loadTabData]
  )

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([loadStats(dateRange), loadTabData(activeTab, dateRange)])
    setLoading(false)
  }, [activeTab, dateRange, loadStats, loadTabData])

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
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
                onValueChange={(v) =>
                  handleDateRangeChange(v as TelemetryDateRange)
                }
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
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <IconRefresh className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <AgentStatsCards stats={stats} loading={loading} />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="adoption">Adoption</TabsTrigger>
          <TabsTrigger value="safety">Safety</TabsTrigger>
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
      </Tabs>
    </div>
  )
}
