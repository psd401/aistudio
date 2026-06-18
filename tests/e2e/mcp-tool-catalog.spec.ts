import { test, expect } from '@playwright/test'

/**
 * E2E tests for the catalog-backed MCP server (Issue #924, Epic #922 ws#2).
 *
 * Exercises the JSON-RPC 2.0 endpoint POST /api/mcp at the API level (no browser
 * auth UI — MCP uses a Bearer API key). Covers the issue's e2e flows:
 *   - MCP tools/list returns catalog-backed tools
 *   - MCP tools/call dispatches via the catalog
 *   - tool manifest auto-registration on boot (full manifest MCP set is listed)
 *
 * The fourth issue flow — "AI SDK chat receives catalog-filtered tools" — lives in
 * tests/e2e/nexus-chat-tools.spec.ts (session-auth route, not the MCP API-key one).
 *
 * Auth note: the authenticated flows require an MCP API key (sk-...) with the
 * relevant mcp:* scopes. Set MCP_E2E_API_KEY to run them; otherwise they skip
 * (CI has no seeded key). The unauthenticated gate tests are CI-compatible and
 * require no key. The deterministic catalog logic (merge, scope/surface filter,
 * dispatch, boot auto-registration) is covered by unit + integration tests under
 * tests/unit/lib/tools and tests/unit/lib/mcp/jsonrpc-catalog.test.ts.
 */

const MCP_KEY = process.env.MCP_E2E_API_KEY

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', method, id, ...(params ? { params } : {}) }
}

test.describe('MCP server — auth gate', () => {
  test('POST /api/mcp without Authorization is rejected', async ({ request }) => {
    const resp = await request.post('/api/mcp', { data: rpc('tools/list') })
    // Unauthenticated requests must not reach the catalog. The auth middleware
    // returns a 401 (exact body is auth-middleware's concern).
    expect(resp.status()).toBe(401)
  })

  test('POST /api/mcp with an invalid bearer is rejected', async ({ request }) => {
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: 'Bearer sk-not-a-real-key' },
      data: rpc('tools/list'),
    })
    expect(resp.status()).toBe(401)
  })
})

test.describe('MCP server — catalog-backed dispatch', () => {
  test.skip(!MCP_KEY, 'Set MCP_E2E_API_KEY to run authenticated MCP flows')

  test('tools/list returns catalog-backed tools', async ({ request }) => {
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${MCP_KEY}` },
      data: rpc('tools/list'),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.jsonrpc).toBe('2.0')
    const tools = body.result?.tools as Array<{ name: string; inputSchema: unknown }>
    expect(Array.isArray(tools)).toBe(true)
    // The catalog exposes the migrated MCP tools by their wire name.
    const names = tools.map((t) => t.name)
    expect(names).toContain('search_decisions')
    // Every listed tool carries a JSON-Schema inputSchema from the catalog.
    expect(tools.every((t) => typeof t.inputSchema === 'object')).toBe(true)
  })

  test('tools/call dispatches via the catalog', async ({ request }) => {
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${MCP_KEY}` },
      data: rpc('tools/call', {
        name: 'search_decisions',
        arguments: { query: 'e2e smoke', limit: 1 },
      }),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.jsonrpc).toBe('2.0')
    // A successful dispatch returns an MCP tool result (content array).
    expect(Array.isArray(body.result?.content)).toBe(true)
  })

  test('tool manifest auto-registered on boot — full MCP set is listed', async ({ request }) => {
    // The boot-time catalog sync (instrumentation.ts -> syncToolCatalog) reconciles
    // lib/tools/catalog/manifest.ts into tool_catalog with source='code'. If the 5
    // migrated MCP tools all appear in tools/list, the whole manifest auto-registered
    // on boot with no SQL migration and no per-tool wiring (issue #924 AC #8).
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${MCP_KEY}` },
      data: rpc('tools/list'),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    const names = (body.result?.tools as Array<{ name: string }>).map((t) => t.name)
    for (const wire of [
      'search_decisions',
      'capture_decision',
      'execute_assistant',
      'list_assistants',
      'get_decision_graph',
    ]) {
      expect(names).toContain(wire)
    }
  })

  test('tools/call for an unknown tool returns METHOD_NOT_FOUND', async ({ request }) => {
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${MCP_KEY}` },
      data: rpc('tools/call', { name: 'no_such_tool', arguments: {} }),
    })
    const body = await resp.json()
    expect(body.error?.code).toBe(-32601)
  })
})
