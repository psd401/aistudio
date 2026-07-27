/**
 * The WAF per-IP rate rule must not count agent server-to-server traffic.
 *
 * `RateLimitRule` (added in #306, 2025-10-03) blocks at 2,000 requests per
 * 5 minutes per IP. That is correct for browsers, which arrive from many
 * distinct addresses.
 *
 * #1353 routed every agent LLM call through /api/agent/model-proxy. Those
 * requests leave the AgentCore runtime through a handful of NAT egress IPs,
 * so a per-IP browser budget counts an entire agent fleet as ONE client — and
 * a single agentic turn makes many model calls. On 2026-07-27 that produced
 * 4,849 WAF-blocked requests in one 5-minute window and the dev agent could
 * not answer at all. The agent surfaced it as:
 *
 *   {"error": "Too many requests. Please try again later."}
 *
 * which is the WAF's custom response body, not application code — so nothing
 * in the app logs explained it.
 *
 * The fix is a scopeDownStatement excluding /api/agent/*. That path is
 * authenticated by a proxy-signed invocation context and, in the deployed
 * runtime, restricted by the Cedar egress allowlist; the WAF was never what
 * protected it.
 *
 * This test reads the CDK source because CI does not run the infra jest
 * suite, so an assertion placed there would never execute.
 */

import fs from "node:fs"
import path from "node:path"

const source = fs
  .readFileSync(
    path.join(process.cwd(), "infra/lib/frontend-stack-ecs.ts"),
    "utf8",
  )
  // Assert against executable source: the rationale above is also written in
  // comments beside the rule, and prose must not be what keeps this green.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "")

describe("WAF rate limiting vs the agent API", () => {
  it("still rate-limits by IP", () => {
    // Guard the parser: if the rule were renamed or removed, every assertion
    // below would pass vacuously.
    expect(source).toContain("RateLimitRule")
    expect(source).toContain("rateBasedStatement")
    expect(source).toContain("aggregateKeyType: 'IP'")
  })

  it("excludes /api/agent/ from the per-IP budget", () => {
    expect(source).toContain("scopeDownStatement")
    expect(source).toContain("notStatement")
    expect(source).toContain("searchString: '/api/agent/'")
    expect(source).toContain("positionalConstraint: 'STARTS_WITH'")
  })

  it("keeps the exclusion inside the rate rule, not a separate allow", () => {
    // A top-level allow rule for /api/agent/ would also stop the blocking,
    // but it would bypass the managed rule sets too. The exclusion has to be
    // scoped to the rate statement alone.
    const rateIdx = source.indexOf("rateBasedStatement")
    const scopeIdx = source.indexOf("scopeDownStatement")
    const managedIdx = source.indexOf("AWSManagedRulesCommonRuleSet")
    expect(rateIdx).toBeGreaterThan(-1)
    expect(scopeIdx).toBeGreaterThan(rateIdx)
    expect(managedIdx).toBeGreaterThan(scopeIdx)
  })
})
