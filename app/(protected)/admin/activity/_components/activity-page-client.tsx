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

import { ActivityStatsCards, ActivityStatsCardsSkeleton } from "./activity-stats-cards"
import { ActivityFiltersComponent } from "./activity-filters"
import { ActivityPagination } from "./activity-pagination"
import { NexusActivityTable } from "./nexus-activity-table"
import { AssistantConversationTable } from "./assistant-conversation-table"
import { ComparisonActivityTable } from "./comparison-activity-table"
import { NexusDetailSheet } from "./nexus-detail-sheet"
import { ComparisonDetailSheet } from "./comparison-detail-sheet"

import {
  getActivityStats,
  getNexusActivity,
  getAssistantConversationActivity,
  getComparisonActivity,
  type ActivityStats,
  type ActivityFilters,
  type NexusActivityItem,
  type AssistantConversationItem,
  type ComparisonActivityItem,
  type StatsDateRange,
} from "@/actions/admin/activity-management.actions"

type ActivityTab = "nexus" | "executions" | "comparisons"

const DATE_RANGE_OPTIONS: { value: StatsDateRange; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "this-month", label: "This month" },
  { value: "6m", label: "Last 6 months" },
  { value: "this-year", label: "This year" },
  { value: "all", label: "All time" },
]

interface ActivityCollectionResult<T> {
  data?: { items: T[]; total: number } | null
  isSuccess: boolean
  message: string
}

type ActivityLoader<T> = (
  filters: ActivityFilters & { page: number; pageSize: number }
) => Promise<ActivityCollectionResult<T>>

function useActivityCollection<T>(
  loader: ActivityLoader<T>,
  errorTitle: string,
  filters: ActivityFilters,
  page: number,
  pageSize: number
) {
  const { toast } = useToast()
  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    const result = await loader({ ...filters, page, pageSize })
    if (result.isSuccess && result.data) {
      setData(result.data.items)
      setTotal(result.data.total)
    } else {
      toast({
        variant: "destructive",
        title: errorTitle,
        description: result.message,
      })
    }
    setLoading(false)
  }, [errorTitle, filters, loader, page, pageSize, toast])

  return { data, loading, reload, total }
}

function useActivityStatistics(statsDateRange: StatsDateRange) {
  const { toast } = useToast()
  const [stats, setStats] = useState<ActivityStats | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const result = await getActivityStats(statsDateRange)
    if (result.isSuccess && result.data) {
      setStats(result.data)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading statistics",
        description: result.message,
      })
    }
    setLoading(false)
  }, [statsDateRange, toast])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) return reload()
    })
    return () => {
      cancelled = true
    }
  }, [reload])

  return { loading, reload, stats }
}

function ActivityHeader({
  handleRefresh,
  statsDateRange,
  setStatsDateRange,
}: {
  handleRefresh: () => void
  statsDateRange: StatsDateRange
  setStatsDateRange: (range: StatsDateRange) => void
}) {
  return (
    <div className="mb-6">
      <PageBranding />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Activity Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor platform usage across Nexus, Assistant Architect, and Model
            Compare
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Stats range:</span>
            <Select
              value={statsDateRange}
              onValueChange={(value) =>
                setStatsDateRange(value as StatsDateRange)
              }
            >
              <SelectTrigger className="w-[160px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
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
  )
}

function toNexusActivity(
  item: AssistantConversationItem
): NexusActivityItem {
  return {
    id: item.id,
    userId: item.userId,
    userEmail: item.userEmail,
    userName: item.userName,
    title: item.title,
    provider: "assistant-architect",
    modelUsed: item.modelUsed,
    messageCount: item.messageCount,
    totalTokens: item.totalTokens,
    costUsd: item.costUsd,
    lastMessageAt: item.lastMessageAt,
    createdAt: item.createdAt,
  }
}

interface ActivityCollectionStatus {
  loading: boolean
  reload: () => Promise<void>
  total: number
}

function getActiveCollection(
  tab: ActivityTab,
  collections: Record<ActivityTab, ActivityCollectionStatus>
): ActivityCollectionStatus {
  return collections[tab]
}

export function ActivityPageClient() {
  const [activeTab, setActiveTab] = useState<ActivityTab>("nexus")
  const [statsDateRange, setStatsDateRange] = useState<StatsDateRange>("30d")
  const [filters, setFilters] = useState<ActivityFilters>({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selectedNexus, setSelectedNexus] = useState<NexusActivityItem | null>(null)
  const [nexusDetailOpen, setNexusDetailOpen] = useState(false)
  const [selectedComparison, setSelectedComparison] = useState<ComparisonActivityItem | null>(null)
  const [comparisonDetailOpen, setComparisonDetailOpen] = useState(false)
  const statistics = useActivityStatistics(statsDateRange)
  const nexus = useActivityCollection(
    getNexusActivity,
    "Error loading Nexus activity",
    filters,
    page,
    pageSize
  )
  const assistant = useActivityCollection(
    getAssistantConversationActivity,
    "Error loading assistant conversations",
    filters,
    page,
    pageSize
  )
  const comparisons = useActivityCollection(
    getComparisonActivity,
    "Error loading comparison activity",
    filters,
    page,
    pageSize
  )

  const activeCollection = getActiveCollection(activeTab, {
    comparisons,
    executions: assistant,
    nexus,
  })
  const activeReload = activeCollection.reload

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) return activeReload()
    })
    return () => {
      cancelled = true
    }
  }, [activeReload])

  // Handle filter changes
  const handleFiltersChange = useCallback((newFilters: ActivityFilters) => {
    setFilters(newFilters)
    setPage(1) // Reset to first page on filter change
  }, [])

  const handleRefresh = useCallback(async () => {
    await Promise.all([statistics.reload(), activeCollection.reload()])
  }, [activeCollection, statistics])

  // Handle tab change
  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value as ActivityTab)
    setPage(1) // Reset pagination when switching tabs
  }, [])

  // Handle page size change
  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize)
    setPage(1) // Reset to first page
  }, [])

  // View detail handlers
  const handleViewNexus = useCallback((item: NexusActivityItem) => {
    setSelectedNexus(item)
    setNexusDetailOpen(true)
  }, [])

  // View assistant conversation detail via the Nexus detail sheet (same underlying conversation)
  const handleViewAssistantConv = useCallback((item: AssistantConversationItem) => {
    setSelectedNexus(toNexusActivity(item))
    setNexusDetailOpen(true)
  }, [])

  const handleViewComparison = useCallback((item: ComparisonActivityItem) => {
    setSelectedComparison(item)
    setComparisonDetailOpen(true)
  }, [])

  return (
    <div className="p-6 space-y-6">
      <ActivityHeader
        handleRefresh={handleRefresh}
        setStatsDateRange={setStatsDateRange}
        statsDateRange={statsDateRange}
      />

      {statistics.loading ? (
        <ActivityStatsCardsSkeleton />
      ) : statistics.stats ? (
        <ActivityStatsCards stats={statistics.stats} />
      ) : null}

      {/* Activity Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="nexus">Nexus Conversations</TabsTrigger>
          <TabsTrigger value="executions">Assistant Architect</TabsTrigger>
          <TabsTrigger value="comparisons">Model Compare</TabsTrigger>
        </TabsList>

        {/* Filters */}
        <div className="mt-4">
          <ActivityFiltersComponent
            onFiltersChange={handleFiltersChange}
            loading={activeCollection.loading}
          />
        </div>

        {/* Nexus Tab */}
        <TabsContent value="nexus" className="mt-4">
          <NexusActivityTable
            data={nexus.data}
            loading={nexus.loading}
            onViewDetail={handleViewNexus}
          />
        </TabsContent>

        {/* Assistant Architect Tab */}
        <TabsContent value="executions" className="mt-4">
          <AssistantConversationTable
            data={assistant.data}
            loading={assistant.loading}
            onViewDetail={handleViewAssistantConv}
          />
        </TabsContent>

        {/* Comparisons Tab */}
        <TabsContent value="comparisons" className="mt-4">
          <ComparisonActivityTable
            data={comparisons.data}
            loading={comparisons.loading}
            onViewDetail={handleViewComparison}
          />
        </TabsContent>
      </Tabs>

      {/* Pagination */}
      {activeCollection.total > 0 && (
        <ActivityPagination
          page={page}
          pageSize={pageSize}
          total={activeCollection.total}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
          loading={activeCollection.loading}
        />
      )}

      {/* Detail Sheets */}
      <NexusDetailSheet
        open={nexusDetailOpen}
        onOpenChange={setNexusDetailOpen}
        conversation={selectedNexus}
      />

      <ComparisonDetailSheet
        open={comparisonDetailOpen}
        onOpenChange={setComparisonDetailOpen}
        comparison={selectedComparison}
      />
    </div>
  )
}
