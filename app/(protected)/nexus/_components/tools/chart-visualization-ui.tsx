'use client'

import { useMemo } from 'react'
import { makeAssistantToolUI, type ToolCallMessagePartStatus } from '@assistant-ui/react'
import { Chart, type ChartSeries } from '@/components/tool-ui/chart'
import { ChartErrorBoundary } from '@/components/tool-ui/chart-error-boundary'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BarChart3, AlertCircle } from 'lucide-react'

/**
 * Tool arguments for the show_chart tool
 */
export interface ChartToolArgs {
  type: 'bar' | 'line' | 'area' | 'scatter' | 'pie'
  title: string
  description?: string
  data: Array<Record<string, unknown>>
  xKey: string
  series: ChartSeries[]
  showLegend?: boolean
  showGrid?: boolean
}

/**
 * Tool result for the show_chart tool
 */
export interface ChartToolResult {
  id: string
  success: boolean
  error?: string
}

// Empty series fallback - memoized at module level
const EMPTY_SERIES: ChartSeries[] = []

// Loading skeleton component
function ChartLoadingSkeleton({ title }: { title?: string }) {
  return (
    <Card className="w-full border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-blue-600 animate-pulse" />
          <CardTitle className="text-sm text-blue-900 dark:text-blue-100">
            Generating chart...
          </CardTitle>
        </div>
        {title && (
          <CardDescription className="text-blue-800 dark:text-blue-200">{title}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-[200px] w-full" />
          <div className="flex gap-2 justify-center">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// Error state component
function ChartErrorState({
  title,
  errorMessage,
}: {
  title?: string
  errorMessage?: string
}) {
  return (
    <Card className="w-full border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          <CardTitle className="text-sm text-red-900 dark:text-red-100">
            Chart Generation Failed
          </CardTitle>
        </div>
        {title && (
          <CardDescription className="text-red-800 dark:text-red-200">{title}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-sm text-red-700 dark:text-red-300">
          {errorMessage || 'An error occurred while generating the chart.'}
        </p>
      </CardContent>
    </Card>
  )
}

// No data warning component
function ChartNoDataState() {
  return (
    <Card className="w-full border-yellow-200 bg-yellow-50/50 dark:border-yellow-800 dark:bg-yellow-950/30">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
          <CardTitle className="text-sm text-yellow-900 dark:text-yellow-100">
            No Data Available
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-yellow-700 dark:text-yellow-300">
          The chart has no data to display.
        </p>
      </CardContent>
    </Card>
  )
}

// Success state component
function ChartSuccessState({
  chartArgs,
  resultId,
}: {
  chartArgs: ChartToolArgs
  resultId?: string
}) {
  // Memoize series to avoid array prop warning
  const series = useMemo(
    () => chartArgs.series || EMPTY_SERIES,
    [chartArgs.series]
  )

  return (
    <ChartErrorBoundary chartTitle={chartArgs.title}>
      <Chart
        id={resultId}
        type={chartArgs.type || 'bar'}
        title={chartArgs.title || 'Chart'}
        description={chartArgs.description}
        data={chartArgs.data}
        xKey={chartArgs.xKey || 'name'}
        series={series}
        showLegend={chartArgs.showLegend ?? true}
        showGrid={chartArgs.showGrid ?? true}
      />
    </ChartErrorBoundary>
  )
}

/**
 * Renderer component for the chart visualization tool UI.
 */
const ChartVisualizationRenderer = ({
  args,
  result,
  status,
}: {
  args: ChartToolArgs
  result?: ChartToolResult
  status: ToolCallMessagePartStatus
}) => {
  // Parse args safely (may come as JSON string from argsText)
  const chartArgs: ChartToolArgs | null = useMemo(() => {
    if (!args) return null
    return typeof args === 'string' ? JSON.parse(args) : args
  }, [args])

  // Loading state
  if (status.type === 'running' || status.type === 'requires-action') {
    return <ChartLoadingSkeleton title={chartArgs?.title} />
  }

  // Error state
  if (status.type === 'incomplete' && status.reason === 'error') {
    return <ChartErrorState title={chartArgs?.title} errorMessage={result?.error} />
  }

  // Validate required chart data
  const hasValidData =
    chartArgs?.data && Array.isArray(chartArgs.data) && chartArgs.data.length > 0

  if (!hasValidData || !chartArgs) {
    return <ChartNoDataState />
  }

  // Success state
  return <ChartSuccessState chartArgs={chartArgs} resultId={result?.id} />
}

/**
 * Assistant UI Tool UI for the show_chart tool.
 */
export const ChartVisualizationUI = makeAssistantToolUI<ChartToolArgs, ChartToolResult>({
  toolName: 'show_chart',
  render: ChartVisualizationRenderer,
})
