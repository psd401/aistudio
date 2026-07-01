"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
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
import { SkillsListClient } from "../skills/_components/skills-list-client"
import { SkillReviewClient } from "../skills/review/_components/skill-review-client"
import { CredentialsClient } from "../credentials/_components/credentials-client"
import { AgentWorkspaceTable } from "./agent-workspace-table"
import { AgentFailuresClient } from "./agent-failures-client"
import { AgentTriageTable } from "./agent-triage-table"
import { AgentConversationsTab } from "./agent-conversations"

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
  getAgentRawSignals,
  type AgentHealthSummary,
  type AgentPatternsEnvelope,
  type RawSignalsEnvelope,
} from "@/actions/admin/agent-health.actions"
import {
  getAgentCostSummary,
  type AgentCostSummary,
  type CostDateRange,
} from "@/actions/admin/agent-cost.actions"
import {
  getAgentCostByModel,
  getAgentCostProjection,
  getPricableModels,
  type AgentCostByModel,
  type AgentCostProjection,
  type PricableModel,
} from "@/actions/admin/agent-cost-projection.actions"
import {
  getTriageSummaryList,
  type TriageSummaryRow,
} from "@/actions/admin/agent-triage.actions"

type DashboardTab =
  | "usage"
  | "adoption"
  | "safety"
  | "feedback"
  | "health"
  | "cost"
  | "patterns"
  | "skills"
  | "skillReview"
  | "credentials"
  | "workspace"
  | "failures"
  | "triage"
  | "conversations"

/**
 * Map telemetry date range to Cost Explorer range.
 * Cost Explorer supports 7/30/90d buckets only. "All time" maps to 30d —
 * the Cost tab shows a note when this mapping occurs.
 */
function telemetryToCostRange(r: TelemetryDateRange): CostDateRange {
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
  setCostByModel: (v: AgentCostByModel | null) => void
  setPricableModels: (v: PricableModel[]) => void
  setSelectedCandidate: (v: string | null) => void
  setPatterns: (v: AgentPatternsEnvelope) => void
  setRawSignals: (v: RawSignalsEnvelope | null) => void
  setTriageList: (v: TriageSummaryRow[]) => void
}

interface LoaderContext extends LoaderSetters {
  showError: (tab: string, message: string) => void
  /** Candidate model currently selected for the projection panel. */
  getSelectedCandidate: () => string | null
  /** Version-guarded projection fetch — only the latest request writes state. */
  runProjection: (range: TelemetryDateRange, candidate: string) => Promise<void>
}

function buildLoaders(
  ctx: LoaderContext
): Record<DashboardTab, (range: TelemetryDateRange) => Promise<void>> {
  return {
    usage: async (range) => {
      const [u, m] = await Promise.all([
        getAgentDailyUsage(range),
        getAgentModelBreakdown(range),
      ])
      if (u.isSuccess && u.data) {
        ctx.setDailyUsage(u.data)
      } else if (!u.isSuccess) {
        ctx.showError("usage", u.message)
      }
      if (m.isSuccess && m.data) {
        ctx.setModelBreakdown(m.data)
      } else if (!m.isSuccess) {
        ctx.showError("usage", m.message)
      }
    },
    adoption: async (range) => {
      const r = await getAgentUserUsage(range)
      if (r.isSuccess && r.data) {
        ctx.setUserUsage(r.data)
      } else {
        ctx.showError("adoption", r.message)
      }
    },
    safety: async (range) => {
      const r = await getAgentGuardrailEvents(range)
      if (r.isSuccess && r.data) {
        ctx.setGuardrailEvents(r.data)
      } else {
        ctx.showError("safety", r.message)
      }
    },
    feedback: async (range) => {
      const r = await getAgentFeedbackList(range)
      if (r.isSuccess && r.data) {
        ctx.setFeedbackList(r.data)
      } else {
        ctx.showError("feedback", r.message)
      }
    },
    health: async () => {
      const r = await getAgentHealthSummary()
      if (r.isSuccess && r.data) {
        ctx.setHealthSummary(r.data)
      } else {
        ctx.showError("health", r.message)
      }
    },
    cost: async (range) => {
      // Token×pricing is the source of truth; Cost Explorer is reconciliation.
      // Load actual cost, candidate models, and Cost Explorer in parallel.
      const [byModel, models, ce] = await Promise.all([
        getAgentCostByModel(range),
        getPricableModels(),
        getAgentCostSummary(telemetryToCostRange(range)),
      ])

      if (byModel.isSuccess && byModel.data) {
        ctx.setCostByModel(byModel.data)
      } else if (!byModel.isSuccess) {
        ctx.setCostByModel(null)
        ctx.showError("cost", byModel.message)
      }

      // Candidate list + default selection (first = cheapest blended).
      let candidate = ctx.getSelectedCandidate()
      if (models.isSuccess && models.data) {
        ctx.setPricableModels(models.data)
        if (!candidate && models.data.length > 0) {
          candidate = models.data[0].modelId
          ctx.setSelectedCandidate(candidate)
        }
      } else if (!models.isSuccess) {
        ctx.setPricableModels([])
      }

      // Cost Explorer reconciliation (kept, relabeled in the UI).
      if (ce.isSuccess && ce.data) {
        ctx.setCostSummary(ce.data)
      } else {
        ctx.setCostSummary(null)
      }

      // Projection for the selected candidate (skip if none priced yet).
      // Routed through the version-guarded runProjection so a slower response
      // here can't clobber a newer candidate selection (claude review, #1083).
      if (candidate) {
        await ctx.runProjection(range, candidate)
      }
    },
    patterns: async () => {
      // Load detected patterns + raw signals in parallel — the raw signal
      // counts let admins see classifier coverage even when zero patterns
      // cross the suppression threshold.
      const [p, rs] = await Promise.all([
        getAgentPatterns(),
        getAgentRawSignals(7),
      ])
      if (p.isSuccess && p.data) {
        ctx.setPatterns(p.data)
      } else if (!p.isSuccess) {
        ctx.showError("patterns", p.message)
      }
      if (rs.isSuccess && rs.data) {
        ctx.setRawSignals(rs.data)
      } else {
        ctx.setRawSignals(null)
      }
    },
    triage: async () => {
      const r = await getTriageSummaryList()
      if (r.isSuccess && r.data) {
        ctx.setTriageList(r.data)
      } else {
        ctx.showError("triage", r.message)
      }
    },
    // Skills, credentials, workspace, failures, and conversations tabs are
    // self-contained — their client components handle their own loading.
    skills: async () => {},
    skillReview: async () => {},
    credentials: async () => {},
    workspace: async () => {},
    failures: async () => {},
    conversations: async () => {},
  }
}

const DATE_RANGE_OPTIONS: { value: TelemetryDateRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
]

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

function DashboardTabs({
  activeTab,
  onTabChange,
  dateRange,
  tabLoading,
  dailyUsage,
  modelBreakdown,
  userUsage,
  guardrailEvents,
  feedbackList,
  healthSummary,
  costSummary,
  costByModel,
  projection,
  pricableModels,
  selectedCandidate,
  onSelectCandidate,
  patterns,
  rawSignals,
  triageList,
}: {
  activeTab: DashboardTab
  onTabChange: (tab: string) => void
  dateRange: TelemetryDateRange
  tabLoading: boolean
  dailyUsage: DailyUsagePoint[]
  modelBreakdown: ModelBreakdownItem[]
  userUsage: UserUsageItem[]
  guardrailEvents: GuardrailEvent[]
  feedbackList: FeedbackItem[]
  healthSummary: AgentHealthSummary | null
  costSummary: AgentCostSummary | null
  costByModel: AgentCostByModel | null
  projection: AgentCostProjection | null
  pricableModels: PricableModel[]
  selectedCandidate: string | null
  onSelectCandidate: (modelId: string) => void
  patterns: AgentPatternsEnvelope
  rawSignals: RawSignalsEnvelope | null
  triageList: TriageSummaryRow[]
}) {
  return (
    <Tabs value={activeTab} onValueChange={onTabChange}>
      <TabsList>
        <TabsTrigger value="usage">Usage</TabsTrigger>
        <TabsTrigger value="cost">Cost</TabsTrigger>
        <TabsTrigger value="adoption">Adoption</TabsTrigger>
        <TabsTrigger value="failures">Failures</TabsTrigger>
        <TabsTrigger value="health">Health</TabsTrigger>
        <TabsTrigger value="safety">Safety</TabsTrigger>
        <TabsTrigger value="patterns">Patterns</TabsTrigger>
        <TabsTrigger value="feedback">Feedback</TabsTrigger>
        <TabsTrigger value="skills">Skills</TabsTrigger>
        <TabsTrigger value="skillReview">Skill Review</TabsTrigger>
        <TabsTrigger value="credentials">Credentials</TabsTrigger>
        <TabsTrigger value="workspace">Workspace</TabsTrigger>
        <TabsTrigger value="triage">Triage</TabsTrigger>
        <TabsTrigger value="conversations">Conversations</TabsTrigger>
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
        {dateRange === "all" && (
          <p className="text-sm text-muted-foreground mb-2">
            The Cost Explorer reconciliation panel does not support &quot;All
            time&quot; — it shows the last 30 days. The token×pricing view above
            it respects the selected period.
          </p>
        )}
        <AgentCostView
          costByModel={costByModel}
          projection={projection}
          pricableModels={pricableModels}
          costExplorer={costSummary}
          selectedCandidate={selectedCandidate}
          onSelectCandidate={onSelectCandidate}
          loading={tabLoading}
        />
      </TabsContent>

      <TabsContent value="patterns" className="mt-4">
        <AgentPatternsTable data={patterns} rawSignals={rawSignals} loading={tabLoading} />
      </TabsContent>

      <TabsContent value="skills" className="mt-4">
        <SkillsListClient />
      </TabsContent>

      <TabsContent value="skillReview" className="mt-4">
        <SkillReviewClient />
      </TabsContent>

      <TabsContent value="credentials" className="mt-4">
        <CredentialsClient />
      </TabsContent>

      <TabsContent value="workspace" className="mt-4">
        <AgentWorkspaceTable />
      </TabsContent>

      <TabsContent value="failures" className="mt-4">
        <AgentFailuresClient />
      </TabsContent>

      <TabsContent value="triage" className="mt-4">
        <AgentTriageTable data={triageList} loading={tabLoading} />
      </TabsContent>

      <TabsContent value="conversations" className="mt-4">
        <AgentConversationsTab />
      </TabsContent>
    </Tabs>
  )
}

/**
 * Cost-tab state + the candidate-change handler, grouped into one hook so the
 * main dashboard component stays readable. The projection re-fetches only when
 * the admin picks a different candidate (the actual cost / Cost Explorer / token
 * data don't change), so the candidate selector is cheap.
 */
function useCostTab(
  dateRange: TelemetryDateRange,
  showError: (tab: string, message: string) => void
) {
  const [costSummary, setCostSummary] = useState<AgentCostSummary | null>(null)
  const [costByModel, setCostByModel] = useState<AgentCostByModel | null>(null)
  const [projection, setProjection] = useState<AgentCostProjection | null>(null)
  const [pricableModels, setPricableModels] = useState<PricableModel[]>([])
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null)
  // Mirror selectedCandidate in a ref so the (stable) cost loader can read the
  // latest value without being recreated on every selection change. Synced via
  // effect (never written during render) so React's ref rules are satisfied.
  const selectedCandidateRef = useRef<string | null>(null)
  useEffect(() => {
    selectedCandidateRef.current = selectedCandidate
  }, [selectedCandidate])

  // Monotonic request token for projection fetches. Both the tab loader and the
  // candidate selector fetch projections; if a user switches range then quickly
  // picks a different candidate, two fetches can resolve out of order. Only the
  // latest-issued request is allowed to write state (claude review, #1083).
  const projectionVersionRef = useRef(0)

  // Single guarded projection fetch used by BOTH the tab loader and the
  // candidate selector, so there is one ordering authority.
  const runProjection = useCallback(
    async (range: TelemetryDateRange, candidate: string) => {
      const version = ++projectionVersionRef.current
      const proj = await getAgentCostProjection(range, [candidate])
      // A newer request superseded us — drop this (stale) result.
      if (version !== projectionVersionRef.current) return
      if (proj.isSuccess && proj.data) {
        setProjection(proj.data)
      } else if (!proj.isSuccess) {
        setProjection(null)
        showError("cost", proj.message)
      }
    },
    [showError]
  )

  const handleSelectCandidate = useCallback(
    async (modelId: string) => {
      setSelectedCandidate(modelId)
      await runProjection(dateRange, modelId)
    },
    [dateRange, runProjection]
  )

  // Stable handle of just the setters + ref + runProjection, so the loader memo
  // that consumes it doesn't re-run every render (state values live outside this
  // object; runProjection only depends on the stable showError).
  const loaderApi = useMemo(
    () => ({
      setCostSummary,
      setCostByModel,
      setPricableModels,
      setSelectedCandidate,
      selectedCandidateRef,
      runProjection,
    }),
    [runProjection]
  )

  return {
    costSummary,
    costByModel,
    projection,
    pricableModels,
    selectedCandidate,
    handleSelectCandidate,
    loaderApi,
  }
}

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
  const [patterns, setPatterns] = useState<AgentPatternsEnvelope>({
    rows: [],
    lastScan: null,
  })
  const [rawSignals, setRawSignals] = useState<RawSignalsEnvelope | null>(null)
  const [triageList, setTriageList] = useState<TriageSummaryRow[]>([])
  const [tabLoading, setTabLoading] = useState(false)

  // Request version counter — prevents stale responses from overwriting
  // newer data when rapid tab/range changes cause overlapping async calls.
  const requestVersion = useRef(0)

  const showError = useCallback(
    (tab: string, message: string) => {
      toast({
        variant: "destructive",
        title: `Error loading ${tab} data`,
        description: message,
      })
    },
    [toast]
  )

  const cost = useCostTab(dateRange, showError)

  const loadStats = useCallback(
    async (range: TelemetryDateRange) => {
      const result = await getAgentTelemetryStats(range)
      if (result.isSuccess && result.data) {
        setStats(result.data)
      } else {
        showError("stats", result.message)
      }
    },
    [showError]
  )

  // `cost.loaderApi` is a stable memoized handle of the cost setters + ref, so
  // along with the stable useState setters, `showError` and `cost.loaderApi`
  // are the only deps. getSelectedCandidate reads the ref so the loader sees the
  // latest candidate without re-memoizing.
  const { loaderApi } = cost
  const loaders = useMemo(
    () => buildLoaders({
      setDailyUsage, setModelBreakdown, setUserUsage, setGuardrailEvents,
      setFeedbackList, setHealthSummary,
      setCostSummary: loaderApi.setCostSummary,
      setCostByModel: loaderApi.setCostByModel,
      setPricableModels: loaderApi.setPricableModels,
      setSelectedCandidate: loaderApi.setSelectedCandidate,
      setPatterns, setRawSignals, setTriageList,
      showError,
      getSelectedCandidate: () => loaderApi.selectedCandidateRef.current,
      runProjection: loaderApi.runProjection,
    }),
    [showError, loaderApi]
  )

  const loadTabData = useCallback(
    async (tab: DashboardTab, range: TelemetryDateRange) => {
      const version = ++requestVersion.current
      setTabLoading(true)

      try {
        await loaders[tab](range)
      } catch {
        // Only show error if this is still the latest request
        if (version === requestVersion.current) {
          toast({
            variant: "destructive",
            title: `Error loading ${tab} data`,
            description: `Failed to load ${tab} data`,
          })
        }
      } finally {
        // Only clear loading if this is still the latest request
        if (version === requestVersion.current) {
          setTabLoading(false)
        }
      }
    },
    [toast, loaders]
  )

  useEffect(() => {
    setLoading(true)
    Promise.all([loadStats("30d"), loadTabData("usage", "30d")]).finally(() =>
      setLoading(false)
    )
  }, [loadStats, loadTabData])

  const handleDateRangeChange = useCallback(
    async (range: TelemetryDateRange) => {
      setDateRange(range)
      setLoading(true)
      try {
        await Promise.all([loadStats(range), loadTabData(activeTab, range)])
      } finally {
        setLoading(false)
      }
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
    try {
      await Promise.all([loadStats(dateRange), loadTabData(activeTab, dateRange)])
    } finally {
      setLoading(false)
    }
  }, [activeTab, dateRange, loadStats, loadTabData])

  return (
    <div className="p-6 space-y-6">
      <DashboardHeader
        dateRange={dateRange}
        onDateRangeChange={handleDateRangeChange}
        onRefresh={handleRefresh}
      />

      <AgentStatsCards stats={stats} loading={loading} />
      <DashboardTabs
        activeTab={activeTab}
        onTabChange={handleTabChange}
        dateRange={dateRange}
        tabLoading={tabLoading}
        dailyUsage={dailyUsage}
        modelBreakdown={modelBreakdown}
        userUsage={userUsage}
        guardrailEvents={guardrailEvents}
        feedbackList={feedbackList}
        healthSummary={healthSummary}
        costSummary={cost.costSummary}
        costByModel={cost.costByModel}
        projection={cost.projection}
        pricableModels={cost.pricableModels}
        selectedCandidate={cost.selectedCandidate}
        onSelectCandidate={cost.handleSelectCandidate}
        patterns={patterns}
        rawSignals={rawSignals}
        triageList={triageList}
      />
    </div>
  )
}
