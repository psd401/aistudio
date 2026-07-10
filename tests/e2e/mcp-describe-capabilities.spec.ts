import { test, expect } from './fixtures'

/**
 * E2E flow `mcp-describe-capabilities` (Issue #1100).
 *
 * Exercises the live capability-catalog meta-tool on POST /api/mcp:
 *   - GUARD (CI-safe, no key): an UNAUTHENTICATED caller never reaches the
 *     catalog, so `describe_capabilities` is never exposed without a credential.
 *   - FUNCTIONAL (gated): with a `platform:read` API key, tools/list surfaces the
 *     tool and tools/call returns a catalog with both `actions[]` (invocable,
 *     incl. `assistants.execute`) and `features[]` (UI map, incl. `model-compare`).
 *
 * The functional flow needs a seeded MCP API key (sk-…) holding `platform:read`;
 * CI has none, so it skips unless PLATFORM_READ_E2E_API_KEY is set. The
 * deterministic scope-gating + projection logic is covered by unit + integration
 * tests (tests/unit/lib/capabilities/capability-catalog.test.ts and
 * tests/unit/lib/mcp/describe-capabilities-tool.test.ts).
 */

const PLATFORM_KEY = process.env.PLATFORM_READ_E2E_API_KEY

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', method, id, ...(params ? { params } : {}) }
}

test.describe('describe_capabilities — auth gate (CI-safe)', () => {
  test('unauthenticated tools/list does not expose describe_capabilities', async ({
    request,
  }) => {
    const resp = await request.post('/api/mcp', { data: rpc('tools/list') })
    // The auth middleware rejects before the catalog runs, so the tool is never
    // listed without a credential.
    expect(resp.status()).toBe(401)
  })

  test('unauthenticated tools/call describe_capabilities is rejected', async ({
    request,
  }) => {
    const resp = await request.post('/api/mcp', {
      data: rpc('tools/call', { name: 'describe_capabilities', arguments: {} }),
    })
    expect(resp.status()).toBe(401)
  })
})

test.describe('describe_capabilities — platform:read caller', () => {
  test.skip(
    !PLATFORM_KEY,
    'Set PLATFORM_READ_E2E_API_KEY (an sk- key holding platform:read) to run'
  )

  test('tools/list surfaces describe_capabilities for a platform:read key', async ({
    request,
  }) => {
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${PLATFORM_KEY}` },
      data: rpc('tools/list'),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    const names = (body.result?.tools as Array<{ name: string }>).map(
      (t) => t.name
    )
    expect(names).toContain('describe_capabilities')
  })

  test('tools/call returns actions[] and features[] with known entries', async ({
    request,
  }) => {
    const resp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${PLATFORM_KEY}` },
      data: rpc('tools/call', {
        name: 'describe_capabilities',
        arguments: {},
      }),
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    // The MCP tool result carries the catalog JSON as a text content block.
    const text = (body.result?.content as Array<{ text: string }>)[0].text
    const catalog = JSON.parse(text) as {
      actions: Array<{ identifier: string; agentInvocable: boolean }>
      features: Array<{ identifier: string }>
    }
    expect(Array.isArray(catalog.actions)).toBe(true)
    expect(Array.isArray(catalog.features)).toBe(true)
    // Known invocable action + known UI feature (the two namespaces).
    expect(
      catalog.actions.some((a) => a.identifier === 'assistants.execute')
    ).toBe(true)
    expect(
      catalog.features.some((f) => f.identifier === 'model-compare')
    ).toBe(true)
  })
})
