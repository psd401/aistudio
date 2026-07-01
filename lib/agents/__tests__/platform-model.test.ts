import { readFileSync } from "fs"
import { join, resolve } from "path"
import { AGENT_MODEL_ID } from "@/lib/agents/platform-model"

/**
 * Drift guard (PR #1087 review finding #4).
 *
 * The agent-platform model id ("anthropic.claude-sonnet-5" as of #1089;
 * formerly "zai.glm-5") is declared independently in four places across three
 * deployables:
 *   1. lib/agents/platform-model.ts            (Next app — AGENT_MODEL_ID)
 *   2. infra/agent-image/openclaw.json         (agent image — runtime model)
 *   3. infra/agent-image/agentcore_wrapper.py  (agent image — telemetry fallback)
 *   4. infra/database/schema/092-...sql         (DB — ai_models pricing row)
 *
 * There is no build-time shared constant across Python / TS / SQL, so a swap
 * (e.g. to a newer Sonnet) that updates one but not all silently re-introduces the exact
 * $0-cost bug #1083 fixed — agent_messages rows stop joining ai_models. This
 * test fails CI the moment any of the four drifts from AGENT_MODEL_ID.
 *
 * LIMITATION (claude review, #1087): the model id actually WRITTEN to
 * agent_messages is whatever mantle_proxy.py extracts from the live Mantle
 * response at runtime (falling back to DEFAULT_AGENT_MODEL_ID, which IS guarded
 * below). A static test cannot assert what the upstream returns — if Mantle
 * starts returning a differently-cased/renamed id, only production telemetry
 * (a spike in pricingMissing rows) reveals it. These four static sites are the
 * drift surface we can guard at build time.
 */

const REPO_ROOT = resolve(__dirname, "../../..")

const read = (rel: string): string =>
  readFileSync(join(REPO_ROOT, rel), "utf8")

interface OpenClawModel {
  id: string
}
interface OpenClawProvider {
  models?: OpenClawModel[]
}
interface OpenClawConfig {
  models: { providers: Record<string, OpenClawProvider> }
  agents: { defaults: { model: { primary: string } } }
}

describe("agent platform model id consistency (#1083 / #1087 #4)", () => {
  const openclaw = JSON.parse(
    read("infra/agent-image/openclaw.json")
  ) as OpenClawConfig

  it("openclaw.json declares AGENT_MODEL_ID as a provider model", () => {
    const ids = Object.values(openclaw.models.providers).flatMap((p) =>
      (p.models ?? []).map((m) => m.id)
    )
    expect(ids).toContain(AGENT_MODEL_ID)
  })

  it("openclaw.json default agent model resolves to AGENT_MODEL_ID", () => {
    // primary is "<provider>/<modelId>"
    const primary = openclaw.agents.defaults.model.primary
    expect(primary.endsWith(`/${AGENT_MODEL_ID}`)).toBe(true)
  })

  it("agentcore_wrapper.py DEFAULT_AGENT_MODEL_ID matches AGENT_MODEL_ID", () => {
    const py = read("infra/agent-image/agentcore_wrapper.py")
    const match = py.match(/DEFAULT_AGENT_MODEL_ID\s*=\s*["']([^"']+)["']/)
    expect(match?.[1]).toBe(AGENT_MODEL_ID)
  })

  it("migration 092 seeds a pricing row for AGENT_MODEL_ID", () => {
    const sql = read("infra/database/schema/092-agent-cache-tokens.sql")
    expect(sql).toContain(`'${AGENT_MODEL_ID}'`)
  })
})
