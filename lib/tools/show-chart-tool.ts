import type { Tool } from 'ai'
import { jsonSchema } from 'ai'
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

// TypeScript types for chart arguments
export interface ChartSeries {
  key: string
  label: string
  color?: string
}

export interface ShowChartArgs {
  type: 'bar' | 'line' | 'area' | 'scatter' | 'pie'
  title: string
  description?: string
  data: Array<Record<string, string | number | boolean | null>>
  xKey: string
  series: ChartSeries[]
  showLegend?: boolean
  showGrid?: boolean
}

// Result type for chart tool execution
export interface ChartToolResult {
  id: string
  success: boolean
  error?: string
}

/**
 * Create the show_chart tool for AI SDK
 *
 * This tool returns a chart configuration that the frontend renders
 * using the ChartVisualizationUI component.
 */
export function createShowChartTool(): Tool<ShowChartArgs, ChartToolResult> {
  // Create JSON Schema compatible with OpenAI Responses API
  const schema = jsonSchema<ShowChartArgs>({
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['bar', 'line', 'area', 'scatter', 'pie'],
        description: 'Chart type: bar (categorical comparisons), line (trends), area (cumulative), scatter (correlations), pie (proportions)'
      },
      title: {
        type: 'string',
        description: 'Chart title',
        minLength: 1,
        maxLength: 100
      },
      description: {
        type: 'string',
        description: 'Optional chart description',
        maxLength: 500
      },
      data: {
        type: 'array',
        description: 'Array of data points. Each object should have a key matching xKey for labels, and keys matching series[].key for numeric values. Example: [{month: "Jan", sales: 100}, {month: "Feb", sales: 150}]',
        items: {
          type: 'object',
          additionalProperties: true
        },
        minItems: 1,
        maxItems: 1000
      },
      xKey: {
        type: 'string',
        description: 'Key in data objects to use for X-axis labels (e.g., "month", "category", "date")'
      },
      series: {
        type: 'array',
        description: 'Series configuration. Each series.key must exist in data objects as numeric values.',
        items: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Data key from the data array'
            },
            label: {
              type: 'string',
              description: 'Display label for the series'
            },
            color: {
              type: 'string',
              description: 'Optional hex color (e.g., #2563eb)'
            }
          },
          required: ['key', 'label']
        },
        minItems: 1,
        maxItems: 10
      },
      showLegend: {
        type: 'boolean',
        description: 'Show chart legend (default: true)'
      },
      showGrid: {
        type: 'boolean',
        description: 'Show grid lines (default: true)'
      }
    },
    required: ['type', 'title', 'data', 'xKey', 'series']
  })

  // Construct the tool object with proper typing
  const chartTool: Tool<ShowChartArgs, ChartToolResult> = {
    description: `Display data as an interactive chart visualization. Use this tool when you have numerical data that would benefit from visual representation.

IMPORTANT: Always use this tool instead of text-based charts, ASCII art, or mermaid diagrams when visualizing data.

Supported chart types:
- bar: For comparing categories (e.g., enrollment by grade)
- line: For trends over time (e.g., scores over months)
- area: For cumulative trends
- scatter: For correlations between variables
- pie: For proportional data (e.g., budget allocation)

Example: To show enrollment data, call with:
{
  "type": "bar",
  "title": "Student Enrollment by Grade",
  "data": [{"grade": "K", "students": 120}, {"grade": "1st", "students": 135}],
  "xKey": "grade",
  "series": [{"key": "students", "label": "Students"}]
}`,
    inputSchema: schema,
    execute: async (args: ShowChartArgs): Promise<ChartToolResult> => {
      const chartId = uuidv4()

      log.info('Chart generation requested', {
        chartId,
        type: args.type,
        title: args.title,
        dataPoints: args.data?.length ?? 0,
        seriesCount: args.series?.length ?? 0
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
  }

  return chartTool
}
