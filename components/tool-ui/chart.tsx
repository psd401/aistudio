'use client'

import { useCallback, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
// Cell imported synchronously - it's lightweight and required for per-item colors
import { Cell } from 'recharts'

// Lazy load Recharts components to reduce initial bundle size (~150KB)
const LazyBarChart = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.BarChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
)
const LazyLineChart = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.LineChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
)
const LazyAreaChart = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.AreaChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
)
const LazyScatterChart = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.ScatterChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
)
const LazyPieChart = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.PieChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
)

// Standard Recharts components
const LazyXAxis = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.XAxis })),
  { ssr: false }
)
const LazyYAxis = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.YAxis })),
  { ssr: false }
)
const LazyCartesianGrid = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.CartesianGrid })),
  { ssr: false }
)
const LazyTooltip = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Tooltip })),
  { ssr: false }
)
const LazyLegend = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Legend })),
  { ssr: false }
)
const LazyBar = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Bar })),
  { ssr: false }
)
const LazyLine = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Line })),
  { ssr: false }
)
const LazyArea = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Area })),
  { ssr: false }
)
const LazyScatter = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Scatter })),
  { ssr: false }
)
const LazyPie = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.Pie })),
  { ssr: false }
)
const LazyResponsiveContainer = dynamic(
  () => import('recharts').then((mod) => ({ default: mod.ResponsiveContainer })),
  { ssr: false }
)

// Colorblind-safe color palette (WCAG AA compliant)
const CHART_COLORS = [
  '#2563eb', // Blue
  '#16a34a', // Green
  '#dc2626', // Red
  '#9333ea', // Purple
  '#ea580c', // Orange
  '#0891b2', // Cyan
  '#c026d3', // Magenta
  '#854d0e', // Brown
] as const

// Dark mode color palette
const CHART_COLORS_DARK = [
  '#60a5fa', // Light Blue
  '#4ade80', // Light Green
  '#f87171', // Light Red
  '#c084fc', // Light Purple
  '#fb923c', // Light Orange
  '#22d3ee', // Light Cyan
  '#e879f9', // Light Magenta
  '#fde047', // Light Yellow
] as const

// Memoized style objects to prevent re-renders
const COMMON_AXIS_PROPS = {
  tick: { fontSize: 12 },
  tickLine: { stroke: 'hsl(var(--border))' },
  axisLine: { stroke: 'hsl(var(--border))' },
} as const

const COMMON_GRID_PROPS = {
  strokeDasharray: '3 3',
  stroke: 'hsl(var(--border))',
  opacity: 0.5,
} as const

const TOOLTIP_STYLE = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '6px',
} as const

const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0]
const LINE_DOT_ACTIVE = { r: 6 } as const

function ChartSkeleton() {
  return (
    <div className="h-[300px] w-full flex items-center justify-center">
      <div className="space-y-2 w-full">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-[250px] w-full" />
        <div className="flex gap-2 justify-center">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
        </div>
      </div>
    </div>
  )
}

export interface ChartSeries {
  key: string
  label: string
  color?: string
}

interface ChartSeriesWithColor extends ChartSeries {
  color: string
}

export interface ChartProps {
  id?: string
  type: 'bar' | 'line' | 'area' | 'scatter' | 'pie'
  title: string
  description?: string
  data: Array<Record<string, unknown>>
  xKey: string
  series: ChartSeries[]
  showLegend?: boolean
  showGrid?: boolean
  height?: number
  className?: string
}

// Pie chart label formatter - extracted to avoid inline function
function formatPieLabel({ name, percent }: { name?: string; percent?: number }): string {
  return `${name ?? ''}: ${((percent ?? 0) * 100).toFixed(0)}%`
}

// Legend component - extracted to reduce main component complexity
interface LegendProps {
  payload?: Array<{ value: string; color: string; dataKey: string }>
  hiddenSeries: Set<string>
  onToggle: (key: string) => void
  visibleCount: number
}

function ChartLegend({ payload, hiddenSeries, onToggle, visibleCount }: LegendProps) {
  // Memoize the click handler - must be before any conditional returns
  const handleClick = useCallback(
    (dataKey: string) => {
      onToggle(dataKey)
    },
    [onToggle]
  )

  if (!payload) return null

  return (
    <div
      className="flex flex-wrap justify-center gap-4 mt-2"
      role="group"
      aria-label="Chart legend - click to toggle series visibility"
    >
      {payload.map((entry) => {
        const isHidden = hiddenSeries.has(entry.dataKey)
        const canHide = visibleCount > 1 || isHidden
        return (
          <LegendButton
            key={entry.dataKey}
            dataKey={entry.dataKey}
            value={entry.value}
            color={entry.color}
            isHidden={isHidden}
            canHide={canHide}
            onClick={handleClick}
          />
        )
      })}
    </div>
  )
}

// Extracted legend button component to avoid inline objects/functions
interface LegendButtonProps {
  dataKey: string
  value: string
  color: string
  isHidden: boolean
  canHide: boolean
  onClick: (key: string) => void
}

function LegendButton({ dataKey, value, color, isHidden, canHide, onClick }: LegendButtonProps) {
  const handleButtonClick = useCallback(() => {
    if (canHide) onClick(dataKey)
  }, [canHide, onClick, dataKey])

  const bgStyle = useMemo(() => ({ backgroundColor: color }), [color])

  return (
    <button
      type="button"
      onClick={handleButtonClick}
      className={cn(
        'flex items-center gap-2 text-sm px-2 py-1 rounded transition-colors',
        'hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring',
        isHidden && 'opacity-50'
      )}
      aria-pressed={!isHidden}
      aria-label={`${value}: ${isHidden ? 'hidden' : 'visible'}`}
    >
      <span className="w-3 h-3 rounded-sm" style={bgStyle} aria-hidden="true" />
      <span className={cn(isHidden && 'line-through')}>{value}</span>
    </button>
  )
}

// Shared chart render options to reduce parameter count
interface ChartRenderOptions {
  data: Array<Record<string, unknown>>
  xKey: string
  visibleSeries: ChartSeriesWithColor[]
  showGrid: boolean
  showLegend: boolean
  legendContent: React.ReactElement
  title: string
}

// Chart type renderers - using options object to reduce param count
function renderBarChart(opts: ChartRenderOptions) {
  const { data, xKey, visibleSeries, showGrid, showLegend, legendContent, title } = opts
  // Use multi-color mode for single series to make each bar a different color
  const useMultiColor = visibleSeries.length === 1

  return (
    <LazyBarChart data={data} aria-label={`Bar chart: ${title}`}>
      {showGrid && <LazyCartesianGrid {...COMMON_GRID_PROPS} />}
      <LazyXAxis dataKey={xKey} {...COMMON_AXIS_PROPS} />
      <LazyYAxis {...COMMON_AXIS_PROPS} />
      <LazyTooltip contentStyle={TOOLTIP_STYLE} />
      {showLegend && !useMultiColor && <LazyLegend content={legendContent} />}
      {visibleSeries.map((s) => (
        <LazyBar
          key={s.key}
          dataKey={s.key}
          name={s.label}
          fill={useMultiColor ? undefined : s.color}
          radius={BAR_RADIUS}
        >
          {useMultiColor && data.map((_, index) => (
            <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
        </LazyBar>
      ))}
    </LazyBarChart>
  )
}

function renderLineChart(opts: ChartRenderOptions) {
  const { data, xKey, visibleSeries, showGrid, showLegend, legendContent, title } = opts
  return (
    <LazyLineChart data={data} aria-label={`Line chart: ${title}`}>
      {showGrid && <LazyCartesianGrid {...COMMON_GRID_PROPS} />}
      <LazyXAxis dataKey={xKey} {...COMMON_AXIS_PROPS} />
      <LazyYAxis {...COMMON_AXIS_PROPS} />
      <LazyTooltip contentStyle={TOOLTIP_STYLE} />
      {showLegend && <LazyLegend content={legendContent} />}
      {visibleSeries.map((s) => (
        <LazyLine
          key={s.key}
          type="monotone"
          dataKey={s.key}
          name={s.label}
          stroke={s.color}
          strokeWidth={2}
          dot
          activeDot={LINE_DOT_ACTIVE}
        />
      ))}
    </LazyLineChart>
  )
}

function renderAreaChart(opts: ChartRenderOptions) {
  const { data, xKey, visibleSeries, showGrid, showLegend, legendContent, title } = opts
  return (
    <LazyAreaChart data={data} aria-label={`Area chart: ${title}`}>
      {showGrid && <LazyCartesianGrid {...COMMON_GRID_PROPS} />}
      <LazyXAxis dataKey={xKey} {...COMMON_AXIS_PROPS} />
      <LazyYAxis {...COMMON_AXIS_PROPS} />
      <LazyTooltip contentStyle={TOOLTIP_STYLE} />
      {showLegend && <LazyLegend content={legendContent} />}
      {visibleSeries.map((s) => (
        <LazyArea
          key={s.key}
          type="monotone"
          dataKey={s.key}
          name={s.label}
          stroke={s.color}
          fill={s.color}
          fillOpacity={0.3}
        />
      ))}
    </LazyAreaChart>
  )
}

function renderScatterChart(opts: ChartRenderOptions) {
  const { data, xKey, visibleSeries, showGrid, showLegend, legendContent, title } = opts
  return (
    <LazyScatterChart aria-label={`Scatter chart: ${title}`}>
      {showGrid && <LazyCartesianGrid {...COMMON_GRID_PROPS} />}
      <LazyXAxis dataKey={xKey} {...COMMON_AXIS_PROPS} />
      <LazyYAxis {...COMMON_AXIS_PROPS} />
      <LazyTooltip contentStyle={TOOLTIP_STYLE} />
      {showLegend && <LazyLegend content={legendContent} />}
      {visibleSeries.map((s) => (
        <LazyScatter key={s.key} name={s.label} data={data} fill={s.color} />
      ))}
    </LazyScatterChart>
  )
}

function renderPieChart(
  data: Array<Record<string, unknown>>,
  xKey: string,
  series: ChartSeries[],
  showLegend: boolean,
  title: string
) {
  const dataKey = series[0]?.key || 'value'
  return (
    <LazyPieChart aria-label={`Pie chart: ${title}`}>
      <LazyPie
        data={data}
        dataKey={dataKey}
        nameKey={xKey}
        cx="50%"
        cy="50%"
        outerRadius={80}
        label={formatPieLabel}
      >
        {data.map((_, index) => (
          <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
        ))}
      </LazyPie>
      <LazyTooltip contentStyle={TOOLTIP_STYLE} />
      {showLegend && <LazyLegend />}
    </LazyPieChart>
  )
}

/**
 * Interactive chart component for visualizing data in AI Studio.
 * Supports bar, line, area, scatter, and pie charts.
 */
export function Chart({
  id,
  type,
  title,
  description,
  data,
  xKey,
  series,
  showLegend = true,
  showGrid = true,
  height = 300,
  className,
}: ChartProps) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set())

  const seriesWithColors = useMemo(
    () =>
      series.map((s, index) => ({
        ...s,
        color: s.color || CHART_COLORS[index % CHART_COLORS.length],
      })),
    [series]
  )

  const visibleSeries = useMemo(
    () => seriesWithColors.filter((s) => !hiddenSeries.has(s.key)),
    [seriesWithColors, hiddenSeries]
  )

  const handleLegendClick = useCallback(
    (dataKey: string) => {
      setHiddenSeries((prev) => {
        const next = new Set(prev)
        if (next.has(dataKey)) {
          next.delete(dataKey)
        } else if (visibleSeries.length > 1) {
          next.add(dataKey)
        }
        return next
      })
    },
    [visibleSeries.length]
  )

  const legendContent = useMemo(
    () =>
      (
        <ChartLegend
          hiddenSeries={hiddenSeries}
          onToggle={handleLegendClick}
          visibleCount={visibleSeries.length}
        />
      ) as unknown as React.ReactElement,
    [hiddenSeries, handleLegendClick, visibleSeries.length]
  )

  const containerStyle = useMemo(() => ({ height }), [height])

  const chartContent = useMemo(() => {
    const opts: ChartRenderOptions = {
      data,
      xKey,
      visibleSeries,
      showGrid,
      showLegend,
      legendContent,
      title,
    }

    switch (type) {
      case 'bar':
        return renderBarChart(opts)
      case 'line':
        return renderLineChart(opts)
      case 'area':
        return renderAreaChart(opts)
      case 'scatter':
        return renderScatterChart(opts)
      case 'pie':
        return renderPieChart(data, xKey, series, showLegend, title)
      default:
        return null
    }
  }, [type, data, xKey, visibleSeries, showGrid, showLegend, legendContent, title, series])

  return (
    <Card id={id} className={cn('w-full', className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div style={containerStyle} className="w-full">
          <LazyResponsiveContainer width="100%" height="100%">
            {chartContent}
          </LazyResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export { CHART_COLORS, CHART_COLORS_DARK }
