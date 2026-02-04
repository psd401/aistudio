"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { IconRefresh } from "@tabler/icons-react"
import { PageBranding } from "@/components/ui/page-branding"

import { ActivityStatsCards, ActivityStatsCardsSkeleton } from "./activity-stats-cards"
import { ActivityFiltersComponent } from "./activity-filters"
import { ActivityPagination } from "./activity-pagination"
import { NexusActivityTable } from "./nexus-activity-table"
import { ExecutionActivityTable } from "./execution-activity-table"
import { AssistantConversationTable } from "./assistant-conversation-table"
import { ComparisonActivityTable } from "./comparison-activity-table"
import { NexusDetailSheet } from "./nexus-detail-sheet"
import { ExecutionDetailSheet } from "./execution-detail-sheet"
import { ComparisonDetailSheet } from "./comparison-detail-sheet"

import {
  getActivityStats,
  getNexusActivity,
  getExecutionActivity,
  getAssistantConversationActivity,
  getComparisonActivity,
  type ActivityStats,
  type ActivityFilters,
  type NexusActivityItem,
  type ExecutionActivityItem,
  type AssistantConversationItem,
  type ComparisonActivityItem,
} from "@/actions/admin/activity-management.actions"

type ActivityTab = "nexus" | "executions" | "comparisons"

export function ActivityPageClient() {
  const { toast } = useToast()

  // State management
  const [activeTab, setActiveTab] = useState<ActivityTab>("nexus")
  const [stats, setStats] = useState<ActivityStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)

  // Filters and pagination state
  const [filters, setFilters] = useState<ActivityFilters>({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // Tab-specific data
  const [nexusData, setNexusData] = useState<NexusActivityItem[]>([])
  const [nexusTotal, setNexusTotal] = useState(0)
  const [nexusLoading, setNexusLoading] = useState(false)

  const [executionData, setExecutionData] = useState<ExecutionActivityItem[]>([])
  const [executionTotal, setExecutionTotal] = useState(0)
  const [executionLoading, setExecutionLoading] = useState(false)

  const [assistantConvData, setAssistantConvData] = useState<AssistantConversationItem[]>([])
  const [assistantConvTotal, setAssistantConvTotal] = useState(0)
  const [assistantConvLoading, setAssistantConvLoading] = useState(false)

  const [comparisonData, setComparisonData] = useState<ComparisonActivityItem[]>([])
  const [comparisonTotal, setComparisonTotal] = useState(0)
  const [comparisonLoading, setComparisonLoading] = useState(false)

  // Detail sheet state
  const [selectedNexus, setSelectedNexus] = useState<NexusActivityItem | null>(null)
  const [nexusDetailOpen, setNexusDetailOpen] = useState(false)

  const [selectedExecution, setSelectedExecution] = useState<ExecutionActivityItem | null>(null)
  const [executionDetailOpen, setExecutionDetailOpen] = useState(false)

  const [selectedComparison, setSelectedComparison] = useState<ComparisonActivityItem | null>(null)
  const [comparisonDetailOpen, setComparisonDetailOpen] = useState(false)

  // Load stats
  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    const result = await getActivityStats()

    if (result.isSuccess && result.data) {
      setStats(result.data)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading statistics",
        description: result.message,
      })
    }
    setStatsLoading(false)
  }, [toast])

  // Load Nexus data
  const loadNexusData = useCallback(async () => {
    setNexusLoading(true)
    const result = await getNexusActivity({ ...filters, page, pageSize })

    if (result.isSuccess && result.data) {
      setNexusData(result.data.items)
      setNexusTotal(result.data.total)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading Nexus activity",
        description: result.message,
      })
    }
    setNexusLoading(false)
  }, [filters, page, pageSize, toast])

  // Load Execution data (scheduled + assistant conversations in parallel)
  const loadExecutionData = useCallback(async () => {
    setExecutionLoading(true)
    setAssistantConvLoading(true)

    const [execResult, convResult] = await Promise.all([
      getExecutionActivity({ ...filters, page, pageSize }),
      getAssistantConversationActivity({ ...filters, page, pageSize }),
    ])

    if (execResult.isSuccess && execResult.data) {
      setExecutionData(execResult.data.items)
      setExecutionTotal(execResult.data.total)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading execution activity",
        description: execResult.message,
      })
    }

    if (convResult.isSuccess && convResult.data) {
      setAssistantConvData(convResult.data.items)
      setAssistantConvTotal(convResult.data.total)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading assistant conversations",
        description: convResult.message,
      })
    }

    setExecutionLoading(false)
    setAssistantConvLoading(false)
  }, [filters, page, pageSize, toast])

  // Load Comparison data
  const loadComparisonData = useCallback(async () => {
    setComparisonLoading(true)
    const result = await getComparisonActivity({ ...filters, page, pageSize })

    if (result.isSuccess && result.data) {
      setComparisonData(result.data.items)
      setComparisonTotal(result.data.total)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading comparison activity",
        description: result.message,
      })
    }
    setComparisonLoading(false)
  }, [filters, page, pageSize, toast])

  // Load stats on mount
  useEffect(() => {
    loadStats()
  }, [loadStats])

  // Load data when tab changes or filters/pagination change
  useEffect(() => {
    if (activeTab === "nexus") {
      loadNexusData()
    } else if (activeTab === "executions") {
      loadExecutionData()
    } else if (activeTab === "comparisons") {
      loadComparisonData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, page, pageSize])

  // Handle filter changes
  const handleFiltersChange = useCallback((newFilters: ActivityFilters) => {
    setFilters(newFilters)
    setPage(1) // Reset to first page on filter change
  }, [])

  // Apply filters after they change
  useEffect(() => {
    if (activeTab === "nexus") {
      loadNexusData()
    } else if (activeTab === "executions") {
      loadExecutionData()
    } else if (activeTab === "comparisons") {
      loadComparisonData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      loadStats(),
      activeTab === "nexus"
        ? loadNexusData()
        : activeTab === "executions"
          ? loadExecutionData()
          : loadComparisonData(),
    ])
  }, [activeTab, loadStats, loadNexusData, loadExecutionData, loadComparisonData])

  // Handle tab change
  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value as ActivityTab)
    setPage(1) // Reset pagination when switching tabs
  }, [])

  // Handle page change
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage)
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

  const handleViewExecution = useCallback((item: ExecutionActivityItem) => {
    setSelectedExecution(item)
    setExecutionDetailOpen(true)
  }, [])

  // View assistant conversation detail via the Nexus detail sheet (same underlying conversation)
  const handleViewAssistantConv = useCallback((item: AssistantConversationItem) => {
    const asNexusItem: NexusActivityItem = {
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
    setSelectedNexus(asNexusItem)
    setNexusDetailOpen(true)
  }, [])

  const handleViewComparison = useCallback((item: ComparisonActivityItem) => {
    setSelectedComparison(item)
    setComparisonDetailOpen(true)
  }, [])

  // Get current loading state
  const isLoading =
    activeTab === "nexus"
      ? nexusLoading
      : activeTab === "executions"
        ? executionLoading
        : comparisonLoading

  // Get current total
  const currentTotal =
    activeTab === "nexus"
      ? nexusTotal
      : activeTab === "executions"
        ? executionTotal
        : comparisonTotal

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="mb-6">
        <PageBranding />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Activity Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor platform usage across Nexus, Assistant Architect, and Model Compare
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <IconRefresh className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {statsLoading ? (
        <ActivityStatsCardsSkeleton />
      ) : stats ? (
        <ActivityStatsCards stats={stats} />
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
            loading={isLoading}
          />
        </div>

        {/* Nexus Tab */}
        <TabsContent value="nexus" className="mt-4">
          <NexusActivityTable
            data={nexusData}
            loading={nexusLoading}
            onViewDetail={handleViewNexus}
          />
        </TabsContent>

        {/* Executions Tab */}
        <TabsContent value="executions" className="mt-4 space-y-6">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Scheduled Executions</h3>
            <ExecutionActivityTable
              data={executionData}
              loading={executionLoading}
              onViewDetail={handleViewExecution}
            />
          </div>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              Manual Assistant Conversations
              {assistantConvTotal > 0 && (
                <span className="ml-2 text-xs">({assistantConvTotal})</span>
              )}
            </h3>
            <AssistantConversationTable
              data={assistantConvData}
              loading={assistantConvLoading}
              onViewDetail={handleViewAssistantConv}
            />
          </div>
        </TabsContent>

        {/* Comparisons Tab */}
        <TabsContent value="comparisons" className="mt-4">
          <ComparisonActivityTable
            data={comparisonData}
            loading={comparisonLoading}
            onViewDetail={handleViewComparison}
          />
        </TabsContent>
      </Tabs>

      {/* Pagination */}
      {currentTotal > 0 && (
        <ActivityPagination
          page={page}
          pageSize={pageSize}
          total={currentTotal}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          loading={isLoading}
        />
      )}

      {/* Detail Sheets */}
      <NexusDetailSheet
        open={nexusDetailOpen}
        onOpenChange={setNexusDetailOpen}
        conversation={selectedNexus}
      />

      <ExecutionDetailSheet
        open={executionDetailOpen}
        onOpenChange={setExecutionDetailOpen}
        execution={selectedExecution}
      />

      <ComparisonDetailSheet
        open={comparisonDetailOpen}
        onOpenChange={setComparisonDetailOpen}
        comparison={selectedComparison}
      />
    </div>
  )
}
