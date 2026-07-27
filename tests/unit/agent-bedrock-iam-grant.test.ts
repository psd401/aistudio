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

/**
 * Quote-aware comment stripper — ONE pass handling both comment forms.
 *
 * A commented-out policy statement still contains the literal text, so a raw
 * substring check would stay green while the deployed role denies every model
 * call.
 *
 * Regexes cannot do this job, and both naive forms fail on THIS file:
 *   • /\/\/.*$/    mangles the ARNs and URLs inside string literals.
 *   • /\/\*[\s\S]*?\*\//  is worse and silently catastrophic: a string literal
 *     containing "/*" opens a comment that never legitimately closes, so the
 *     regex deletes everything up to the next "*\/" elsewhere in the file.
 *     Measured on agent-platform-stack.ts, that removed 100,907 of 203,156
 *     characters — HALF the source, including the grant under test — and every
 *     assertion here would have reported a missing grant that is present.
 *
 * So this walks the source once, tracking whether it is inside a string, a
 * template literal, or a comment, and only treats a marker found in code as a
 * comment. Escapes are honored so "\'" does not end a string.
 */
function stripComments(src: string): string {
  let out = ""
  let quote: string | null = null
  let inLine = false
  let inBlock = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]

    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (quote) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}

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
  it("strips commented-out grants without eating live code (negative control)", () => {
    // Without this control the suite is untrustworthy in BOTH directions: a
    // no-op stripper passes on commented-out grants, and an over-eager one
    // deletes the real grant and fails on correct source. Both have happened.
    const sample = [
      'const url = "https://psd401.ai/x"',
      'const glob = "/*.ts"', // the literal that broke the regex version
      "// const dead = DEAD_LINE",
      "/* const dead2 = DEAD_BLOCK */",
      "const live = KEEP_ME",
    ].join("\n")
    const stripped = stripComments(sample)

    expect(stripped).toContain("https://psd401.ai/x")
    expect(stripped).toContain("/*.ts")
    expect(stripped).toContain("KEEP_ME")
    expect(stripped).not.toContain("DEAD_LINE")
    expect(stripped).not.toContain("DEAD_BLOCK")
  })

  it("preserves the bulk of the real stack source", () => {
    // Bounds the catastrophic-strip failure directly: the regex version cut
    // agent-platform-stack.ts roughly in half. Comments are dense here, but
    // losing more than 70% means the stripper is eating code again.
    const raw = fs.readFileSync(
      path.join(root, "infra/lib/agent-platform-stack.ts"),
      "utf8",
    )
    expect(stackSource.length).toBeGreaterThan(raw.length * 0.3)
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
