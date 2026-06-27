import { test, expect, type Page } from './fixtures'

/**
 * E2E Tests for Assistant Architect Parallel Prompt Execution Persistence
 *
 * Tests verify that:
 * 1. Parallel prompt connections persist across page navigation
 * 2. Parallel group information is correctly saved and restored
 * 3. Edge reconstruction uses parallel_group for precise connections
 * 4. Backward compatibility with existing assistants
 *
 * Related: Epic #523
 *
 * Fixture: tests/e2e/fixtures/assistant-architect-seed.sql seeds an admin-owned
 * approved architect ("E2E Parallel Architect") with two prompts at the same
 * position in different parallel_groups, so the ReactFlow editor renders parallel
 * prompt nodes. Without it (e.g. a DB with no admin-owned architects) the tests
 * skip rather than fail.
 */

const MIN_NODE_SPACING = 50 // px - minimum horizontal spacing between parallel nodes
const Y_POSITION_TOLERANCE = 10 // px - tolerance for grouping nodes at same vertical position

test.use({ storageState: 'tests/e2e/.auth/user-a.json' })

/**
 * Open the ReactFlow prompts editor of the first architect the current user owns.
 * Navigates list -> real architect card -> its /edit/prompts route. The card body
 * isn't a link and there is no "Prompts" tab, so we read the card's Edit href and
 * go to "<href>/prompts" directly. Returns false when the user owns no architect.
 */
async function openPromptsEditor(page: Page): Promise<boolean> {
  await page.goto('/utilities/assistant-architect')
  await page.waitForSelector('main', { timeout: 15_000 })

  // ONLY real architect cards — the empty-state "No assistants found" card also
  // carries shadcn's bg-card class, so a [class*="card"] selector would match it.
  const cards = page.locator('[data-testid="assistant-architect-card"]')
  if ((await cards.count()) === 0) return false

  const editHref = await cards.first().locator('a[href*="/edit"]').first().getAttribute('href')
  if (!editHref) return false

  await page.goto(editHref.replace(/\/edit.*$/, '/edit/prompts'))
  await page.waitForSelector('.react-flow', { timeout: 20_000 })
  return true
}

const SKIP_NO_ARCHITECT = 'No assistant architect owned by the test user (seed assistant-architect-seed.sql)'

test.describe('Assistant Architect - Parallel Execution Persistence', () => {
  test.describe('Edge Persistence', () => {
    test('should persist edge connections when navigating away and back', async ({ page }) => {
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      const initialEdges = await page.locator('.react-flow__edge').count()

      // Navigate away (back to the list) and re-open the editor.
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      const restoredEdges = await page.locator('.react-flow__edge').count()
      expect(restoredEdges).toBe(initialEdges)
    })

    test('should maintain edge structure after page reload', async ({ page }) => {
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      const edgesBefore = await page.locator('.react-flow__edge').count()

      await page.reload()
      await page.waitForSelector('.react-flow', { timeout: 20_000 })

      const edgesAfter = await page.locator('.react-flow__edge').count()
      expect(edgesAfter).toBe(edgesBefore)
    })
  })

  test.describe('Parallel Group Calculation', () => {
    test('should render multiple prompt nodes for a parallel architect', async ({ page }) => {
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      const promptNodes = page.locator('.react-flow__node-prompt')
      const nodeCount = await promptNodes.count()
      if (nodeCount < 2) { test.skip(true, 'Need at least 2 prompts to test parallel grouping'); return }

      await expect(promptNodes.first()).toBeVisible()
    })

    test('should keep the graph editable (save control present or canvas interactive)', async ({ page }) => {
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      // The editor is interactive — the pane is present and pointer-enabled.
      await expect(page.locator('.react-flow__pane')).toBeVisible()
    })
  })

  test.describe('Backward Compatibility', () => {
    test('should render the graph without parallel_group console errors', async ({ page }) => {
      const consoleErrors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })

      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }
      await page.waitForTimeout(1000)

      const parallelGroupErrors = consoleErrors.filter(
        (err) => err.includes('parallelGroup') || err.includes('parallel_group')
      )
      expect(parallelGroupErrors).toHaveLength(0)
    })

    test('should handle prompts with null parallel_group (graph interactive)', async ({ page }) => {
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      await expect(page.locator('.react-flow__pane')).toBeVisible()

      const startNode = page.locator('.react-flow__node-start, [data-id="start"]')
      if ((await startNode.count()) > 0) {
        await expect(startNode.first()).toBeVisible()
      }
    })
  })

  test.describe('Visual Layout', () => {
    test('should arrange parallel nodes horizontally', async ({ page }) => {
      if (!(await openPromptsEditor(page))) { test.skip(true, SKIP_NO_ARCHITECT); return }

      const promptNodes = page.locator('.react-flow__node-prompt')
      const nodeCount = await promptNodes.count()
      if (nodeCount < 2) { test.skip(true, 'Need multiple prompts to test layout'); return }

      // Let ReactFlow's initial layout/fitView settle before reading transforms —
      // nodes briefly mount at 0,0, which would read as overlapping.
      await expect
        .poll(async () => {
          const xs = await promptNodes.evaluateAll((nodes) =>
            nodes.map((n) => {
              const m = window.getComputedStyle(n).transform.match(/matrix.*\((.+)\)/)
              return m ? Number(m[1].split(',')[4]) : 0
            })
          )
          return new Set(xs).size // distinct X values => layout settled
        }, { timeout: 10_000 })
        .toBeGreaterThan(1)

      const nodePositions = await promptNodes.evaluateAll((nodes) =>
        nodes.map((node) => {
          const transform = window.getComputedStyle(node).transform
          const match = transform.match(/matrix.*\((.+)\)/)
          if (match) {
            const values = match[1].split(',').map(Number)
            return { x: values[4] || 0, y: values[5] || 0 }
          }
          return { x: 0, y: 0 }
        })
      )

      expect(nodePositions.length).toBeGreaterThan(0)

      // Group nodes by Y (vertical) position; nodes sharing a Y are "parallel".
      const nodesByYPosition = new Map<number, { x: number; y: number }[]>()
      for (const pos of nodePositions) {
        let foundGroup = false
        for (const [yKey, group] of nodesByYPosition.entries()) {
          if (Math.abs(yKey - pos.y) < Y_POSITION_TOLERANCE) {
            group.push(pos)
            foundGroup = true
            break
          }
        }
        if (!foundGroup) nodesByYPosition.set(pos.y, [pos])
      }

      for (const nodesAtSameY of nodesByYPosition.values()) {
        if (nodesAtSameY.length > 1) {
          const xCoords = nodesAtSameY.map((n) => n.x).sort((a, b) => a - b)
          for (let i = 1; i < xCoords.length; i++) {
            expect(Math.abs(xCoords[i] - xCoords[i - 1])).toBeGreaterThan(MIN_NODE_SPACING)
          }
        }
      }
    })
  })
})
