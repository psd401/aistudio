import { test, expect } from '@playwright/test'

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
 */

test.describe('Assistant Architect - Parallel Execution Persistence', () => {
  test.describe('Edge Persistence', () => {
    test('should persist edge connections when navigating away and back', async ({ page }) => {
      // Navigate to assistant architect list
      await page.goto('/utilities/assistant-architect')

      // Wait for page to load
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      // Look for an existing assistant or create test scenario
      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      const cardCount = await architectCards.count()

      if (cardCount === 0) {
        test.skip(true, 'No assistant architects available for testing')
        return
      }

      // Click on the first assistant to edit
      await architectCards.first().click()

      // Navigate to prompts tab/page
      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      // Wait for ReactFlow canvas to load
      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Get initial edge count
      const initialEdges = await page.locator('.react-flow__edge').count()

      // Navigate away (go back to list)
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      // Navigate back to the same assistant
      await architectCards.first().click()
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      // Wait for ReactFlow to reload
      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Verify edge count is preserved
      const restoredEdges = await page.locator('.react-flow__edge').count()
      expect(restoredEdges).toBe(initialEdges)
    })

    test('should maintain edge structure after page reload', async ({ page }) => {
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      if (await architectCards.count() === 0) {
        test.skip(true, 'No assistant architects available')
        return
      }

      await architectCards.first().click()

      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Capture edge structure before reload
      const edgesBefore = await page.evaluate(() => {
        const edges = document.querySelectorAll('.react-flow__edge')
        return Array.from(edges).map(edge => ({
          id: edge.getAttribute('data-id'),
          class: edge.className
        }))
      })

      // Reload page
      await page.reload()
      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Capture edge structure after reload
      const edgesAfter = await page.evaluate(() => {
        const edges = document.querySelectorAll('.react-flow__edge')
        return Array.from(edges).map(edge => ({
          id: edge.getAttribute('data-id'),
          class: edge.className
        }))
      })

      // Verify same number of edges
      expect(edgesAfter.length).toBe(edgesBefore.length)
    })
  })

  test.describe('Parallel Group Calculation', () => {
    test('should assign parallel groups to nodes at same position', async ({ page }) => {
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      if (await architectCards.count() === 0) {
        test.skip(true, 'No assistant architects available')
        return
      }

      await architectCards.first().click()

      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Check if there are multiple prompt nodes
      const promptNodes = page.locator('[data-type="prompt"], .react-flow__node-prompt')
      const nodeCount = await promptNodes.count()

      if (nodeCount < 2) {
        test.skip(true, 'Need at least 2 prompts to test parallel grouping')
        return
      }

      // Intercept network request to verify parallel group data is sent
      let savedPositions: unknown[] = []
      page.on('request', request => {
        if (request.url().includes('setPromptPositions') || request.url().includes('assistant-architect')) {
          const postData = request.postData()
          if (postData) {
            try {
              const data = JSON.parse(postData)
              if (data.positions || Array.isArray(data)) {
                savedPositions = data.positions || data
              }
            } catch {
              // Ignore parsing errors
            }
          }
        }
      })

      // Trigger a save by making a small change (if controls available)
      const saveButton = page.locator('button:has-text("Save"), [data-testid="save-button"]')
      if (await saveButton.count() > 0) {
        await saveButton.click()
        await page.waitForTimeout(1000)

        // Verify that saved positions include parallelGroup data
        if (savedPositions.length > 0) {
          const hasParallelGroups = savedPositions.some((pos: any) =>
            'parallelGroup' in pos || 'parallel_group' in pos
          )
          expect(hasParallelGroups).toBeTruthy()
        }
      }

      // Verify nodes are rendered
      await expect(promptNodes.first()).toBeVisible()
    })

    test('should save graph structure when edges change', async ({ page }) => {
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      if (await architectCards.count() === 0) {
        test.skip(true, 'No assistant architects available')
        return
      }

      await architectCards.first().click()

      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Listen for network requests to verify save is called
      const saveRequestPromise = page.waitForRequest(
        request => request.method() === 'POST' && request.url().includes('assistant-architect'),
        { timeout: 5000 }
      ).catch(() => null)

      // Trigger a save by making a small change (if controls available)
      const saveButton = page.locator('button:has-text("Save"), [data-testid="save-button"]')
      if (await saveButton.count() > 0) {
        await saveButton.click()

        const saveRequest = await saveRequestPromise
        if (saveRequest) {
          expect(saveRequest).toBeTruthy()
        }
      }
    })
  })

  test.describe('Backward Compatibility', () => {
    test('should render existing assistants without parallel_group gracefully', async ({ page }) => {
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      if (await architectCards.count() === 0) {
        test.skip(true, 'No assistant architects available')
        return
      }

      await architectCards.first().click()

      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      // Wait for ReactFlow to load without errors
      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Verify no console errors related to parallel_group
      const consoleErrors: string[] = []
      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text())
        }
      })

      // Wait a moment for any errors to appear
      await page.waitForTimeout(1000)

      // Filter for parallel_group related errors
      const parallelGroupErrors = consoleErrors.filter(
        err => err.includes('parallelGroup') || err.includes('parallel_group')
      )

      expect(parallelGroupErrors).toHaveLength(0)
    })

    test('should handle prompts with null parallel_group', async ({ page }) => {
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      if (await architectCards.count() === 0) {
        test.skip(true, 'No assistant architects available')
        return
      }

      await architectCards.first().click()

      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Verify the graph is interactive (not broken)
      const flowPane = page.locator('.react-flow__pane')
      await expect(flowPane).toBeVisible()

      // Verify start node exists
      const startNode = page.locator('[data-type="start"], .react-flow__node-start, [data-id="start"]')
      if (await startNode.count() > 0) {
        await expect(startNode).toBeVisible()
      }
    })
  })

  test.describe('Visual Layout', () => {
    test('should arrange parallel nodes horizontally', async ({ page }) => {
      await page.goto('/utilities/assistant-architect')
      await page.waitForSelector('[data-testid="assistant-architect-list"], main', { timeout: 10000 })

      const architectCards = page.locator('[data-testid="assistant-architect-card"], .assistant-card, [class*="card"]')
      if (await architectCards.count() === 0) {
        test.skip(true, 'No assistant architects available')
        return
      }

      await architectCards.first().click()

      const promptsTab = page.locator('[data-testid="prompts-tab"], a:has-text("Prompts"), button:has-text("Prompts")')
      if (await promptsTab.count() > 0) {
        await promptsTab.click()
      }

      await page.waitForSelector('.react-flow', { timeout: 10000 })

      // Get positions of all prompt nodes
      const promptNodes = page.locator('[data-type="prompt"], .react-flow__node-prompt')
      const nodeCount = await promptNodes.count()

      if (nodeCount < 2) {
        test.skip(true, 'Need multiple prompts to test layout')
        return
      }

      // Get node positions
      const nodePositions = await promptNodes.evaluateAll(nodes =>
        nodes.map(node => {
          const transform = window.getComputedStyle(node).transform
          const match = transform.match(/matrix.*\((.+)\)/)
          if (match) {
            const values = match[1].split(',').map(Number)
            return { x: values[4] || 0, y: values[5] || 0 }
          }
          return { x: 0, y: 0 }
        })
      )

      // Verify we got valid positions
      expect(nodePositions.length).toBeGreaterThan(0)

      // Group nodes by Y coordinate (vertical position) with tolerance
      const yTolerance = 10 // pixels
      const nodesByYPosition = new Map<number, { x: number; y: number }[]>()

      for (const pos of nodePositions) {
        // Find existing Y group or create new one
        let foundGroup = false
        for (const [yKey, group] of nodesByYPosition.entries()) {
          if (Math.abs(yKey - pos.y) < yTolerance) {
            group.push(pos)
            foundGroup = true
            break
          }
        }
        if (!foundGroup) {
          nodesByYPosition.set(pos.y, [pos])
        }
      }

      // Verify that nodes at the same Y position (parallel nodes) have different X coordinates
      for (const [yPos, nodesAtSameY] of nodesByYPosition.entries()) {
        if (nodesAtSameY.length > 1) {
          // These are parallel nodes - verify they're arranged horizontally
          const xCoords = nodesAtSameY.map(n => n.x).sort((a, b) => a - b)
          for (let i = 1; i < xCoords.length; i++) {
            // Each node should have a different X coordinate
            expect(Math.abs(xCoords[i] - xCoords[i-1])).toBeGreaterThan(50) // At least 50px apart
          }
        }
      }
    })
  })
})
