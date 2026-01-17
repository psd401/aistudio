import { tool } from 'ai'
import { z } from 'zod'
import { createLogger } from '@/lib/logger'
import { v4 as uuidv4 } from 'uuid'

/**
 * Show Chart Tool for AI Assistants
 *
 * This tool allows AI models to generate interactive chart visualizations
 * that are rendered in the chat UI. The frontend ChartVisualizationUI
 * component renders the chart based on the tool arguments.
 *
 * Supported chart types:
 * - bar: Vertical bar charts for categorical comparisons
 * - line: Line charts for trends over time
 * - area: Area charts for cumulative trends
 * - scatter: Scatter plots for correlations
 * - pie: Pie charts for proportional data
 */

const log = createLogger({ module: 'show-chart-tool' })

// Chart series schema for multi-series charts
const ChartSeriesSchema = z.object({
  key: z.string().describe('Data key from the data array'),
  label: z.string().describe('Display label for the series'),
  color: z.string().optional().describe('Optional hex color (e.g., #2563eb)')
})

// Main chart parameters schema
const ShowChartSchema = z.object({
  type: z.enum(['bar', 'line', 'area', 'scatter', 'pie']).describe(
    'Chart type: bar (categorical comparisons), line (trends), area (cumulative), scatter (correlations), pie (proportions)'
  ),
  title: z.string().min(1).max(100).describe('Chart title'),
  description: z.string().max(500).optional().describe('Optional chart description'),
  data: z.array(z.record(z.string(), z.unknown())).min(1).max(1000).describe(
    'Array of data points. Each object represents a data point with named values.'
  ),
  xKey: z.string().describe(
    'Key in data objects to use for X-axis (e.g., "month", "category", "date")'
  ),
  series: z.array(ChartSeriesSchema).min(1).max(10).describe(
    'Series configuration for the Y-axis values to display'
  ),
  showLegend: z.boolean().optional().default(true).describe('Show chart legend'),
  showGrid: z.boolean().optional().default(true).describe('Show grid lines')
})

/**
 * Create the show_chart tool for AI SDK
 *
 * This tool returns a chart configuration that the frontend renders
 * using the ChartVisualizationUI component.
 */
export function createShowChartTool(): unknown {
  return tool({
    description: `Display data as an interactive chart visualization. Use this when you have data that would benefit from visual representation. Supports bar charts (for comparing categories), line charts (for trends over time), area charts (for cumulative data), scatter plots (for correlations), and pie charts (for proportions). Always include clear titles and appropriate series labels.

Example usage:
- Show enrollment by grade level: Use bar chart with grades on x-axis
- Show test scores over time: Use line chart with dates on x-axis
- Show budget allocation: Use pie chart with categories
- Show correlation between study time and grades: Use scatter plot`,
    parameters: ShowChartSchema,
    // @ts-expect-error - AI SDK v5 tool() function has complex type inference that doesn't match TypeScript's requirements
    execute: async (args: z.infer<typeof ShowChartSchema>) => {
      const chartId = uuidv4()

      log.info('Chart generation requested', {
        chartId,
        type: args.type,
        title: args.title,
        dataPoints: args.data.length,
        seriesCount: args.series.length
      })

      try {
        // Validate data structure
        if (!args.data || args.data.length === 0) {
          return {
            id: chartId,
            success: false,
            error: 'No data provided for chart'
          }
        }

        // Check that xKey exists in at least the first data point
        const firstDataPoint = args.data[0]
        if (!(args.xKey in firstDataPoint)) {
          return {
            id: chartId,
            success: false,
            error: `X-axis key "${args.xKey}" not found in data`
          }
        }

        // Check that all series keys exist in data
        for (const series of args.series) {
          if (!(series.key in firstDataPoint)) {
            return {
              id: chartId,
              success: false,
              error: `Series key "${series.key}" not found in data`
            }
          }
        }

        log.info('Chart generated successfully', { chartId, type: args.type })

        // Return success - the frontend will render the chart from args
        return {
          id: chartId,
          success: true
        }
      } catch (error) {
        log.error('Chart generation failed', {
          chartId,
          error: error instanceof Error ? error.message : String(error)
        })

        return {
          id: chartId,
          success: false,
          error: error instanceof Error ? error.message : 'Chart generation failed'
        }
      }
    }
  }) as unknown
}

// Export types for use in components
export type ChartSeries = z.infer<typeof ChartSeriesSchema>
export type ShowChartArgs = z.infer<typeof ShowChartSchema>
