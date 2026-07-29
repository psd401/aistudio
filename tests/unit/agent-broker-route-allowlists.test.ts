/**
 * Agent broker route allowlists must agree (#1239).
 *
 * Reaching a `/api/agent/*` broker route from inside the agent container has
 * to clear THREE independent gates, in this order:
 *
 *   1. skills/_shared/agent-broker.js  — ALLOWED_ROUTES, the skill-side helper
 *   2. mantle_proxy.py                 — ALLOWED_AGENT_BROKER_ROUTES, the relay
 *   3. cedar/psd-agent-governance.cedar — the deployed AgentCore network policy,
 *                                         which DEFAULT-DENIES every outbound
 *                                         request not explicitly listed
 *
 * Each layer fails differently and none of them fails loudly at build time:
 * miss (1) and the helper throws locally; miss (2) and the relay 404s; miss
 * (3) and the request is blocked only IN THE DEPLOYED RUNTIME, so a route can
 * pass every local test and every CI job and still be dead in production.
 *
 * That last case is exactly what happened while adding
 * /api/agent/directory-lookup: layers 1 and 2 were updated, layer 3 was not,
 * and nothing in the repo would have caught it. Hence this test.
 *
 * The Cedar file deliberately carries no wildcard below /api/agent/ ("Fixed
 * signed brokers. No wildcard below /api/agent/ is intentional."), so every
 * route needs BOTH an apex and a wildcard-subdomain entry.
 */


import path from "node:path"
import { validatedFs } from "@/lib/filesystem/validated-fs";

const root = process.cwd()

/**
 * Every parser below reads COMMENT-STRIPPED source.
 *
 * A commented-out entry still contains the literal text, so a raw substring
 * or regex check would keep this suite green while the deployed policy
 * default-denies the route — the test would assert the presence of prose
 * rather than of an active rule.
 *
 * The stripper is QUOTE-AWARE on purpose. A naive line-comment regex destroys
 * every line here, because these allowlists are lists of URLs and "https://"
 * itself contains the comment marker. So the scan walks each line character by
 * character and only cuts at a marker found OUTSIDE a quoted string.
 */
function stripComments(src: string, marker: "//" | "#"): string {
  const out: string[] = []
  for (const line of src.split("\n")) {
    let quote: string | null = null
    let cut = line.length
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote) {
        if (ch === "\\") i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch
        continue
      }
      if (marker === "#" && ch === "#") {
        cut = i
        break
      }
      if (marker === "//" && ch === "/" && line[i + 1] === "/") {
        cut = i
        break
      }
    }
    out.push(line.slice(0, cut))
  }
  return out.join("\n")
}

/** Block comments never contain an active allowlist entry. */
const stripBlocks = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "")

const read = (rel: string) => validatedFs.readFileSync(path.join(root, rel), "utf8")

const helperSrc = stripComments(
  stripBlocks(read("infra/agent-image/skills/_shared/agent-broker.js")),
  "//",
)
const proxySrc = stripComments(read("infra/agent-image/mantle_proxy.py"), "#")
const cedarSrc = stripComments(
  read("infra/policies/cedar/psd-agent-governance.cedar"),
  "//",
)

/** Routes in the skill-side helper's ALLOWED_ROUTES set. */
function helperRoutes(): string[] {
  const block = helperSrc.match(/const ALLOWED_ROUTES = new Set\(\[([\s\S]*?)\]\)/)
  if (!block) throw new Error("could not locate ALLOWED_ROUTES in agent-broker.js")
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Routes in the python relay's ALLOWED_AGENT_BROKER_ROUTES frozenset. */
function proxyRoutes(): string[] {
  const block = proxySrc.match(
    /ALLOWED_AGENT_BROKER_ROUTES = frozenset\(\{([\s\S]*?)\}\)/,
  )
  if (!block) {
    throw new Error("could not locate ALLOWED_AGENT_BROKER_ROUTES in mantle_proxy.py")
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

describe("agent broker route allowlists", () => {
  it("finds a non-trivial route list in each layer", () => {
    // Guards the parsers themselves: a regex that silently matched nothing
    // would make every assertion below vacuously pass.
    expect(helperRoutes().length).toBeGreaterThan(5)
    expect(proxyRoutes().length).toBeGreaterThan(5)
    expect(cedarSrc).toContain("/api/agent/")
  })

  it("the relay allows every route the skill helper can request", () => {
    const proxy = new Set(proxyRoutes())
    const missing = helperRoutes().filter((r) => !proxy.has(r))
    expect(missing).toEqual([])
  })

  it("the skill helper knows every route the relay would forward", () => {
    // Both directions: a route the relay forwards but no skill can name is
    // dead weight in the trusted surface, and worth noticing.
    const helper = new Set(helperRoutes())
    const missing = proxyRoutes().filter((r) => !helper.has(r))
    expect(missing).toEqual([])
  })

  it("the Cedar network policy permits every allowlisted route", () => {
    // THE DEPLOY-ONLY GATE. Cedar default-denies outbound HTTP, so a route
    // absent here is blocked in the deployed runtime while passing every
    // local check. Both the apex and wildcard-subdomain forms are required
    // because the policy carries no wildcard below /api/agent/.
    const missing: string[] = []
    for (const route of helperRoutes()) {
      const apex = `resource.url like "https://psd401.ai${route}"`
      const wildcard = `resource.url like "https://*.psd401.ai${route}"`
      if (!cedarSrc.includes(apex)) missing.push(`apex: ${route}`)
      if (!cedarSrc.includes(wildcard)) missing.push(`wildcard: ${route}`)
    }
    expect(missing).toEqual([])
  })

  it("includes the directory-lookup route in all three layers", () => {
    // Pinned by name: this is the route whose Cedar entry was missed, and the
    // omission was invisible to every other gate in the repo.
    const route = "/api/agent/directory-lookup"
    expect(helperRoutes()).toContain(route)
    expect(proxyRoutes()).toContain(route)
    expect(cedarSrc).toContain(`resource.url like "https://psd401.ai${route}"`)
    expect(cedarSrc).toContain(`resource.url like "https://*.psd401.ai${route}"`)
  })
})
