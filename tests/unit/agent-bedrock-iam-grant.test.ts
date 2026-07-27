/**
 * The agent's chat model must be reachable by SigV4 from the execution role.
 *
 * Until now the model-facing container authenticated to Bedrock with a bearer
 * key that was hydrated from Secrets Manager and INLINED into openclaw.json —
 * inside the same container that runs 33 model-authored skills. #1353 replaced
 * that with a loopback proxy to a web broker, which removed the on-disk key but
 * put an authenticated ALB hop in front of every model call.
 *
 * SigV4 from the AgentCore execution role removes both. The embedding path
 * (memorySearch -> titan-embed-text-v2) has used exactly this mechanism in
 * production since #1184, which is why we know it works from inside a microVM.
 *
 * TWO WAYS THIS BREAKS AT DEPLOY TIME AND NOWHERE ELSE:
 *
 *  1. us.anthropic.claude-sonnet-5 is a CROSS-REGION inference profile. Bedrock
 *     authorizes against the profile ARN *and* the foundation-model ARN in
 *     whichever region it routes to. A grant naming only the profile fails 100%
 *     of the time; a grant missing one member region fails INTERMITTENTLY,
 *     because routing is per-request. Neither shows up in synth or in any test
 *     that does not assert the ARN set explicitly.
 *
 *  2. The IAM grant and openclaw.json are edited independently. Changing the
 *     model in the config without changing the grant yields AccessDenied on
 *     every turn, with a config that looks entirely correct in review.
 *
 * This reads the CDK source because CI does not run the infra jest suite, so an
 * assertion placed there would never execute (same reason as
 * waf-agent-api-scope-down.test.ts).
 */

import fs from "node:fs"
import path from "node:path"

const root = process.cwd()

import { stripComments } from "../helpers/strip-ts-comments"

const stackSource = stripComments(
  fs.readFileSync(path.join(root, "infra/lib/agent-platform-stack.ts"), "utf8"),
)

const openclaw = JSON.parse(
  fs.readFileSync(path.join(root, "infra/agent-image/openclaw.json"), "utf8"),
) as {
  models: {
    providers: Record<
      string,
      {
        apiKey?: string
        auth?: string
        api?: string
        models?: Array<{ id?: string }>
      }
    >
  }
  agents: { defaults: { model: { primary: string } } }
}

/**
 * Regions the Sonnet 5 inference profile routes to. Verified 2026-07-27 with
 * `aws bedrock get-inference-profile --inference-profile-identifier
 * us.anthropic.claude-sonnet-5`.
 */
const PROFILE_REGIONS = ["us-east-1", "us-east-2", "us-west-2"]

describe("agent Bedrock access via execution-role SigV4", () => {
  it("reads real, comment-stripped source (parser guard)", () => {
    // The stripper's own behaviour is pinned in strip-ts-comments.test.ts.
    // Here we only confirm it produced usable source, so the assertions below
    // cannot pass vacuously against an empty or gutted string.
    const raw = fs.readFileSync(
      path.join(root, "infra/lib/agent-platform-stack.ts"),
      "utf8",
    )
    expect(stackSource.length).toBeGreaterThan(raw.length * 0.3)
    expect(stackSource).toContain("AgentCoreExecutionRole")
  })

  it("grants the chat model to the execution role", () => {
    // Guard the parse: a renamed sid would make the ARN assertions vacuous.
    expect(stackSource).toContain("BedrockChatModelInvoke")
    expect(stackSource).toContain("'bedrock:InvokeModel'")
    expect(stackSource).toContain("'bedrock:InvokeModelWithResponseStream'")
  })

  it("grants BOTH the inference profile and every member foundation model", () => {
    // The failure this exists to prevent: profile-only grants AccessDeny 100%
    // of calls, and a missing member region fails only on requests routed
    // there — an intermittent, region-dependent outage.
    expect(stackSource).toContain(
      "inference-profile/us.anthropic.claude-sonnet-5",
    )
    expect(stackSource).toContain("foundation-model/anthropic.claude-sonnet-5")
    for (const region of PROFILE_REGIONS) {
      expect(stackSource).toContain(`'${region}'`)
    }
  })

  it("keeps the embedding grant separate from the chat grant", () => {
    // They are reached by different code paths (memorySearch vs chat) and must
    // fail independently; collapsing them into one statement would widen the
    // embedding grant to the chat model and vice versa.
    expect(stackSource).toContain("BedrockMemoryEmbeddingOnly")
    expect(stackSource).toContain(
      "foundation-model/amazon.titan-embed-text-v2:0",
    )
  })

  it("points openclaw.json at the provider the grant covers", () => {
    // THE DRIFT GATE. IAM and openclaw.json are edited independently; a model
    // change here without a grant change is AccessDenied on every turn.
    const [provider, modelId] =
      openclaw.agents.defaults.model.primary.split("/")
    expect(provider).toBe("amazon-bedrock")
    expect(modelId).toBe("us.anthropic.claude-sonnet-5")
    expect(stackSource).toContain(`inference-profile/${modelId}`)

    const declared = openclaw.models.providers[provider]?.models?.map(
      (m) => m.id,
    )
    expect(declared).toContain(modelId)
  })

  it("selects SigV4 auth and carries no credential", () => {
    // auth "aws-sdk" is a MODE SELECTOR, not a credential — it is what tells
    // OpenClaw to sign with the AWS chain instead of looking for a key. Both
    // it and the matching api are required, and omitting them does not fall
    // back gracefully: the turn dies before reaching Bedrock with
    //   ProviderAuthError: No API key found for provider "amazon-bedrock"
    // which reads like a missing secret rather than a missing config key.
    // These two values are the shape the plugin itself emits for an implicit
    // Bedrock provider (discovery.js resolveImplicitBedrockProvider).
    const provider = openclaw.models.providers["amazon-bedrock"]
    expect(provider).toBeDefined()
    expect(provider.auth).toBe("aws-sdk")
    expect(provider.api).toBe("bedrock-converse-stream")

    // An apiKey WOULD be a credential, and would defeat the change: the plugin
    // skips the AWS default chain whenever a bearer is present
    // (aws-credential-refresh.js), silently reverting to
    // credential-in-container while still appearing to work.
    expect(provider.apiKey).toBeUndefined()
  })

  it("no longer routes chat through the loopback credential proxy", () => {
    // mantle_proxy.py still serves /agent-broker/* and must NOT be deleted —
    // this only asserts that the CHAT path no longer depends on it.
    const providers = Object.keys(openclaw.models.providers)
    expect(providers).not.toContain("amazon-bedrock-mantle")
    expect(JSON.stringify(openclaw.models.providers)).not.toContain("18791")
  })
})
