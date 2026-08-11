
import { join, resolve } from "node:path"
import {
  AGENT_MODEL_ID,
  AGENT_MODEL_ID_ALIASES,
  AGENT_REQUEST_MODEL_ID,
} from "@/lib/agents/platform-model"
import { validatedFs } from "@/lib/filesystem/validated-fs";

/**
 * Drift guard (PR #1087 review finding #4).
 *
 * The agent-platform model id is declared independently across three
 * deployables. As of #1089 (Sonnet 5 over Mantle's Anthropic Messages API) the
 * REQUEST id and the RECORDED id DIFFER, so there are two constants:
 *   - AGENT_REQUEST_MODEL_ID ("anthropic.claude-sonnet-5") — what OpenClaw SENDS:
 *       1. infra/agent-image/openclaw.json         (agent image — runtime model)
 *   - AGENT_MODEL_ID ("claude-sonnet-5") — what Mantle RECORDS + we price:
 *       2. infra/agent-image/agentcore_wrapper.py  (agent image — telemetry fallback)
 *       3. infra/database/schema/092-...sql         (DB — ai_models pricing row)
 *
 * There is no build-time shared constant across Python / TS / SQL, so a swap
 * (e.g. to a newer Sonnet) that updates one but not all silently re-introduces the exact
 * $0-cost bug #1083 fixed — agent_messages rows stop joining ai_models. This
 * test fails CI the moment any of these drifts.
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
  validatedFs.readFileSync(join(REPO_ROOT, rel), "utf8")

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

const defineAgentPlatformModelIdConsistency108310874Suite1 = () => {
  const openclaw = JSON.parse(
    read("infra/agent-image/openclaw.json")
  ) as OpenClawConfig

  it("openclaw.json declares AGENT_REQUEST_MODEL_ID as a provider model", () => {
    const ids = Object.values(openclaw.models.providers).flatMap((p) =>
      (p.models ?? []).map((m) => m.id)
    )
    expect(ids).toContain(AGENT_REQUEST_MODEL_ID)
  })

  it("openclaw.json default agent model resolves to AGENT_REQUEST_MODEL_ID", () => {
    // primary is "<provider>/<modelId>"
    const primary = openclaw.agents.defaults.model.primary
    expect(primary.endsWith(`/${AGENT_REQUEST_MODEL_ID}`)).toBe(true)
  })

  it("agentcore_wrapper.py DEFAULT_AGENT_MODEL_ID matches AGENT_MODEL_ID (recorded id)", () => {
    const py = read("infra/agent-image/agentcore_wrapper.py")
    const match = py.match(/DEFAULT_AGENT_MODEL_ID\s*=\s*["']([^"']+)["']/)
    expect(match?.[1]).toBe(AGENT_MODEL_ID)
  })

  it("migration 092 seeds pricing rows for BOTH the recorded and request ids", () => {
    const sql = read("infra/database/schema/092-agent-cache-tokens.sql")
    // Recorded id (what agent_messages.model actually contains) must be priced.
    expect(sql).toContain(`'${AGENT_MODEL_ID}'`)
    // Request id seeded as an alias too (defensive, in case Mantle ever echoes it).
    expect(sql).toContain(`'${AGENT_REQUEST_MODEL_ID}'`)
  })

  it("every harness alias is priced, so no historical id reads as $0", () => {
    // agent_messages still holds rows under the OLD ids (dev: `claude-sonnet-5`
    // up to 2026-07-29, `us.anthropic.claude-sonnet-5` from 2026-07-31). The
    // cost UI aggregates across the whole range, so an unpriced alias silently
    // drops those rows to $0 rather than failing.
    const sql = read("infra/database/schema/092-agent-cache-tokens.sql")
    for (const alias of AGENT_MODEL_ID_ALIASES) {
      expect(sql).toContain(`'${alias}'`)
    }
  })

  it("the alias list covers both the recorded and request ids", () => {
    // The projection filter excludes by this list; a current id missing from it
    // would offer the harness model as a projection candidate against itself.
    expect(AGENT_MODEL_ID_ALIASES).toContain(AGENT_MODEL_ID)
    expect(AGENT_MODEL_ID_ALIASES).toContain(AGENT_REQUEST_MODEL_ID)
  })
};

describe("agent platform model id consistency (#1083 / #1087 #4)", defineAgentPlatformModelIdConsistency108310874Suite1)
