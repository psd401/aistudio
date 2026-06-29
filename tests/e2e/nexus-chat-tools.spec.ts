import { test, expect } from './fixtures'

/**
 * E2E for the AI SDK chat tool surface of the unified tool catalog
 * (Issue #924, Epic #922 ws#2) — the issue flow "AI SDK chat receives
 * catalog-filtered tools".
 *
 * The Nexus chat route (POST /api/nexus/chat) scope-gates the client-supplied
 * `enabledTools` list through the catalog before building any provider-native
 * tools: `scopeFilterEnabledTools` -> `toolCatalogInstance.filterAiSdkToolNames`
 * drops any `ai_sdk` tool the caller's roles/scopes do not permit (e.g. the
 * `chat:write`-scoped web_search / code_interpreter / generateImage), while the
 * universal `show_chart` (no scope) always survives.
 *
 * Coverage split (matches the repo's e2e convention, see mcp-tool-catalog.spec.ts):
 *   - The deterministic catalog filter — the exact function the route calls — is
 *     integration-tested in tests/unit/lib/tools/catalog.test.ts
 *     (`filterAiSdkToolNames drops tools the caller lacks scope for`, the
 *     scope-held case, and the friendly-alias case).
 *   - This spec covers the wire-level security boundary: the gate is server-side
 *     and only runs for authenticated callers, so an unauthenticated request can
 *     never enable a tool. That assertion is CI-runnable (no session needed).
 */

function chatBody(enabledTools: string[]) {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    modelId: 'gpt-4o',
    provider: 'openai',
    enabledTools,
  }
}

test.describe('Nexus chat — AI SDK tools are catalog-gated server-side', () => {
  test('unauthenticated chat request enabling a scoped tool is rejected (401)', async ({
    request,
  }) => {
    // No session -> the route returns 401 before any tool is enabled. The catalog
    // scope-gate is reached only for authenticated callers, so tools cannot be
    // enabled by an unauthenticated client regardless of the enabledTools sent.
    const resp = await request.post('/api/nexus/chat', {
      data: chatBody(['web_search_preview', 'show_chart']),
    })
    expect(resp.status()).toBe(401)
  })
})
