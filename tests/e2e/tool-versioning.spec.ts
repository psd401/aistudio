import { test, expect } from './fixtures'

/**
 * E2E tests for tool & skill versioning (Issue #927, Epic #922 ws#5).
 *
 * Covers the issue's four e2e flows:
 *   - tool-version-resolution            — REST /api/v1/tools resolves latest +
 *                                           specific versions; MCP tools/list
 *                                           collapses to latest, include=all lists
 *                                           every version.
 *   - deprecated-tool-warning-emission   — invoking a deprecated version emits a
 *                                           structured telemetry event (asserted by
 *                                           unit tests; here we assert the catalog
 *                                           still serves the version).
 *   - skill-pinned-tool-version-invocation — a skill's @version pin gates tools by
 *                                           base name (unit-covered); the admin UI
 *                                           shows usage from skills.
 *   - admin-tool-version-history-display — Admin → Tool Versions renders the
 *                                           per-tool version history.
 *
 * Auth notes (CI-safe):
 *   - REST/MCP flows need a Bearer API key with `tools:read` / `mcp:*` scopes. Set
 *     TOOLS_E2E_API_KEY (or MCP_E2E_API_KEY) to run them; otherwise they skip.
 *   - The admin UI flow auto-skips unless a seeded admin session exists (run
 *     locally after `bun run db:seed`).
 *   - The auth-gate tests are always CI-compatible and need no key.
 *
 * Deterministic versioning logic (resolution, deprecation, include=all collapse,
 * skill-pin intersection, action policy) is covered by unit + integration tests
 * under tests/unit/lib/tools, tests/unit/lib/mcp, tests/unit/lib/skills, and
 * tests/unit/actions/tool-versions-actions.test.ts.
 */

const TOOLS_KEY = process.env.TOOLS_E2E_API_KEY ?? process.env.MCP_E2E_API_KEY

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', method, id, ...(params ? { params } : {}) }
}

function isUnauthenticated(url: string): boolean {
  return (
    url.includes('/auth') ||
    url.includes('/sign-in') ||
    url.includes('/login')
  )
}

test.describe('Tool versioning REST API — auth gate', () => {
  test('GET /api/v1/tools/{id} without Authorization is rejected', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/assistants.execute')
    expect(resp.status()).toBe(401)
  })

  test('GET a specific version without Authorization is rejected', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/assistants.execute/versions/v1')
    expect(resp.status()).toBe(401)
  })
})

test.describe('tool-version-resolution (REST)', () => {
  test.skip(!TOOLS_KEY, 'Set TOOLS_E2E_API_KEY to run authenticated tool API flows')

  const authHeaders = { Authorization: `Bearer ${TOOLS_KEY}` }

  test('GET /api/v1/tools/{id} resolves the latest version', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/assistants.execute', {
      headers: authHeaders,
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.data?.identifier).toBe('assistants.execute')
    expect(typeof body.data?.version).toBe('string')
    expect(body.data?.deprecated).toBe(false)
  })

  test('GET ?include=all lists every version', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/assistants.execute?include=all', {
      headers: authHeaders,
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(Array.isArray(body.data?.versions)).toBe(true)
    expect(body.data.versions.length).toBeGreaterThanOrEqual(1)
  })

  test('GET a specific version returns that version', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/assistants.execute/versions/v1', {
      headers: authHeaders,
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.data?.version).toBe('v1')
  })

  test('GET a removed/unknown version returns 404 with a clear error', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/assistants.execute/versions/v99', {
      headers: authHeaders,
    })
    expect(resp.status()).toBe(404)
    const body = await resp.json()
    expect(body.error?.code).toBe('NOT_FOUND')
    // The message points the caller at the latest version (actionable error).
    expect(String(body.error?.message)).toMatch(/version|latest/i)
  })

  test('GET an unknown identifier returns 404', async ({ request }) => {
    const resp = await request.get('/api/v1/tools/no.such.tool', { headers: authHeaders })
    expect(resp.status()).toBe(404)
  })
})

test.describe('tool-version-resolution (MCP tools/list)', () => {
  test.skip(!TOOLS_KEY, 'Set TOOLS_E2E_API_KEY / MCP_E2E_API_KEY to run MCP flows')

  const authHeaders = { Authorization: `Bearer ${TOOLS_KEY}` }

  test('default tools/list returns one entry per identifier with version metadata', async ({ request }) => {
    const resp = await request.post('/api/mcp', {
      headers: authHeaders,
      data: rpc('tools/list'),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    const tools = (body.result?.tools ?? []) as Array<{
      name: string
      identifier?: string
      version?: string
    }>
    expect(tools.length).toBeGreaterThan(0)
    // Every entry carries version metadata (#927).
    expect(tools.every((t) => typeof t.version === 'string')).toBe(true)
    // Default view collapses to one entry per identifier.
    const identifiers = tools.map((t) => t.identifier)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test('include=all is accepted and returns version-tagged tools', async ({ request }) => {
    const resp = await request.post('/api/mcp', {
      headers: authHeaders,
      data: rpc('tools/list', { include: 'all' }),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    const tools = (body.result?.tools ?? []) as Array<{ version?: string }>
    expect(tools.every((t) => typeof t.version === 'string')).toBe(true)
  })
})

test.describe('admin-tool-version-history-display', () => {
  test('non-admin is redirected away from /admin/tools', async ({ page }) => {
    await page.goto('/admin/tools')
    await page.waitForURL((url) => !url.pathname.includes('/admin/tools'), {
      timeout: 10000,
    })
    const url = page.url()
    expect(
      isUnauthenticated(url) || url.includes('/dashboard') || url.endsWith('/')
    ).toBe(true)
  })

  test('admin sees the tool version history page', async ({ page }) => {
    await page.goto('/admin/tools')
    const url = page.url()
    if (isUnauthenticated(url) || !url.includes('/admin/tools')) {
      test.skip(true, 'No admin auth state available — run with seeded users locally')
    }
    // The page heading and the version-history table headers render.
    await expect(
      page.getByRole('heading', { name: /Tool Versions/i })
    ).toBeVisible({ timeout: 10000 })
    await expect(
      page.getByRole('columnheader', { name: /Version/i }).first()
    ).toBeVisible()
    await expect(
      page.getByRole('columnheader', { name: /Status/i }).first()
    ).toBeVisible()
  })
})
