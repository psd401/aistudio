import { createShowChartTool } from '../show-chart-tool'
import type { ChartToolResult } from '../show-chart-tool'

describe('show-chart-tool', () => {
  const tool = createShowChartTool()

  // AI SDK Tool.execute requires a second options arg; cast for test harness
  const execute = (args: Parameters<NonNullable<typeof tool.execute>>[0]) =>
    tool.execute!(args, {} as Parameters<NonNullable<typeof tool.execute>>[1]) as Promise<ChartToolResult>

  describe('sanitizeChartArgs does not mutate args in place', () => {
    it('should not modify the original args object when data contains HTML-encodable characters', async () => {
      const args = {
        type: 'line' as const,
        title: 'Top Courses',
        description: 'Comparison of GHH and PHS',
        data: [
          { course: 'Nutrition & Food Prep', GHH: 36, PHS: 0 },
          { course: 'Glass Art 1', GHH: 30, PHS: 2 },
        ],
        xKey: 'course',
        series: [
          { key: 'GHH', label: 'Gig Harbor High School' },
          { key: 'PHS', label: 'Peninsula High School' },
        ],
      }

      // Deep clone to compare after execution
      const originalArgs = JSON.parse(JSON.stringify(args))

      await execute(args)

      // The args object passed to execute must NOT be mutated
      // This is the root cause of issue #808 — mutation causes argsText drift
      expect(args).toEqual(originalArgs)
    })

    it('should not mutate original args when data contains HTML-encodable characters', async () => {
      const args = {
        type: 'bar' as const,
        title: 'Test & Chart',
        data: [
          { name: 'A & B', value: 10 },
          { name: 'C < D', value: 20 },
        ],
        xKey: 'name',
        series: [{ key: 'value', label: 'Value' }],
      }

      await execute(args)

      // Original values must be preserved (not HTML-encoded)
      expect(args.title).toBe('Test & Chart')
      expect(args.data[0].name).toBe('A & B')
      expect(args.data[1].name).toBe('C < D')
    })
  })

  describe('execute returns correct result', () => {
    it('should return success with a chart ID', async () => {
      const args = {
        type: 'bar' as const,
        title: 'Test Chart',
        data: [{ name: 'A', value: 10 }],
        xKey: 'name',
        series: [{ key: 'value', label: 'Value' }],
      }

      const result = await execute(args)

      expect(result.success).toBe(true)
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
    })

    it('should return error when data is empty', async () => {
      const args = {
        type: 'bar' as const,
        title: 'Empty Chart',
        data: [],
        xKey: 'name',
        series: [{ key: 'value', label: 'Value' }],
      }

      const result = await execute(args)

      expect(result.success).toBe(false)
      expect(result.error).toContain('No data')
    })

    it('should return error when xKey is missing from data', async () => {
      const args = {
        type: 'bar' as const,
        title: 'Bad Key',
        data: [{ name: 'A', value: 10 }],
        xKey: 'nonexistent',
        series: [{ key: 'value', label: 'Value' }],
      }

      const result = await execute(args)

      expect(result.success).toBe(false)
      expect(result.error).toContain('nonexistent')
    })
  })
})
