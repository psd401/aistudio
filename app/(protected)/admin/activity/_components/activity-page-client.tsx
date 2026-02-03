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
import { ComparisonActivityTable } from "./comparison-activity-table"
import { NexusDetailSheet } from "./nexus-detail-sheet"
import { ExecutionDetailSheet } from "./execution-detail-sheet"
import { ComparisonDetailSheet } from "./comparison-detail-sheet"

import {
  getActivityStats,
  getNexusActivity,
  getExecutionActivity,
  getComparisonActivity,
  type ActivityStats,
  type ActivityFilters,
  type NexusActivityItem,
  type ExecutionActivityItem,
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

  // Load Execution data
  const loadExecutionData = useCallback(async () => {
    setExecutionLoading(true)
    const result = await getExecutionActivity({ ...filters, page, pageSize })

    if (result.isSuccess && result.data) {
      setExecutionData(result.data.items)
      setExecutionTotal(result.data.total)
    } else {
      toast({
        variant: "destructive",
        title: "Error loading execution activity",
        description: result.message,
      })
    }
    setExecutionLoading(false)
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
        <TabsContent value="executions" className="mt-4">
          <ExecutionActivityTable
            data={executionData}
            loading={executionLoading}
            onViewDetail={handleViewExecution}
          />
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
