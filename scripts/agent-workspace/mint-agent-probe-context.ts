/**
 * Mint a short-lived invocation context for the agent-image build gate (#1161).
 *
 * `infra/agent-image/build-and-push.sh` boots the freshly-built image and drives
 * one real turn through `/invocations` before pushing. Since PR #1353 the image
 * holds no provider credential: the model call is brokered by the web tier at
 * `APP_BASE_URL/api/agent/model-proxy`, which authorizes the caller from a
 * router-signed invocation context plus a per-request proof signature. So the
 * probe needs BOTH of these, and they must be issued by something that can read
 * the HMAC signing secret — which the AgentCore execution role is explicitly
 * denied (agent-platform-stack.ts, `DenyInvocationSigningSecret`).
 *
 * This script is that issuer, for a human at a laptop. It signs a canary-owned
 * context exactly the way the router Lambda does — by importing the router's own
 * implementation, so there is no second copy of the token format to drift.
 *
 * Run (from the repo root):
 *   bun run agent:probe-context                    # shell exports, ready to eval
 *   bun run agent:probe-context -- --json          # machine-readable
 *   eval "$(bun run --silent agent:probe-context)" # load into the current shell
 *
 * Requires AWS credentials that can read
 * `psd-agent/<env>/invocation-signing-key`, or `AGENT_INVOCATION_SIGNING_SECRET`
 * set directly (useful against a local `bun run dev:local` broker).
 *
 * See docs/operations/agent-image-build-gate.md.
 */

import { randomUUID } from "node:crypto"
import {
  createInvocationContextToken,
  deriveInvocationRequestProofKey,
  type InvocationMode,
} from "../../infra/lambdas/agent-router/invocation-context"

/** The wrapper's own guards (agentcore_wrapper.py) — fail here, not at boot. */
const INVOCATION_CONTEXT_RE = /^v1\.[\w-]{40,3500}\.[\w-]{43}$/
const REQUEST_PROOF_KEY_RE = /^[\w-]{43}$/
/** lib/agent-workspace/validation.ts SAFE_EMAIL_RE — the verifier rejects anything else. */
const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/

/**
 * `.invalid` is reserved by RFC 2606, so this can never collide with a real
 * mailbox — but it still satisfies the verifier's email shape. The web tier
 * meters model-proxy spend per ownerEmail, so probe turns bill to their own
 * bucket instead of a staff member's.
 */
const DEFAULT_OWNER = "canary@build-gate.invalid"
const DEFAULT_TTL_SECONDS = 900

interface Options {
  environment: string
  secretId: string | undefined
  owner: string
  sessionId: string
  ttlSeconds: number
  mode: InvocationMode
  json: boolean
}

const USAGE = `Mint a short-lived AgentCore probe invocation context (#1161 build gate).

Usage:
  bun run agent:probe-context [-- options]

Options:
  --env <name>       Environment whose signing key to use (default: $ENVIRONMENT or "dev")
  --secret-id <id>   Override the Secrets Manager id / ARN
  --owner <email>    Canary actor+owner email (default: ${DEFAULT_OWNER})
  --session <id>     Session id recorded in the token (default: probe-<uuid>)
  --ttl <seconds>    Token lifetime, 30-7200 (default: ${DEFAULT_TTL_SECONDS})
  --mode <mode>      owner | consultation | scheduled (default: owner)
  --json             Emit JSON instead of shell exports
  -h, --help         Show this help

Environment:
  AGENT_INVOCATION_SIGNING_SECRET     Use this secret verbatim, skip Secrets Manager
  AGENT_INVOCATION_SIGNING_SECRET_ID  Default for --secret-id
  AWS_REGION                          Region for Secrets Manager (default: us-east-1)
`

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    environment: process.env.ENVIRONMENT ?? "dev",
    secretId: process.env.AGENT_INVOCATION_SIGNING_SECRET_ID,
    owner: DEFAULT_OWNER,
    sessionId: `probe-${randomUUID()}`,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    mode: "owner",
    json: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const takeValue = (): string => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`)
      }
      index += 1
      return value
    }
    switch (flag) {
      case "--env":
        options.environment = takeValue()
        break
      case "--secret-id":
        options.secretId = takeValue()
        break
      case "--owner":
        options.owner = takeValue()
        break
      case "--session":
        options.sessionId = takeValue()
        break
      case "--ttl":
        options.ttlSeconds = Number(takeValue())
        break
      case "--mode": {
        const mode = takeValue()
        if (mode !== "owner" && mode !== "consultation" && mode !== "scheduled") {
          throw new Error(`--mode must be owner|consultation|scheduled, got "${mode}"`)
        }
        options.mode = mode
        break
      }
      case "--json":
        options.json = true
        break
      case "-h":
      case "--help":
        console.log(USAGE)
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument "${flag}"\n\n${USAGE}`)
    }
  }

  if (!SAFE_EMAIL_RE.test(options.owner)) {
    throw new Error(
      `--owner "${options.owner}" is not a shape the verifier accepts ` +
        `(lib/agent-workspace/validation.ts SAFE_EMAIL_RE) — it needs a dotted domain, ` +
        `e.g. ${DEFAULT_OWNER}`
    )
  }
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 30 || options.ttlSeconds > 7200) {
    throw new Error(`--ttl must be an integer between 30 and 7200, got "${options.ttlSeconds}"`)
  }
  return options
}

async function resolveSigningSecret(options: Options): Promise<string> {
  const direct = process.env.AGENT_INVOCATION_SIGNING_SECRET
  if (direct) return direct

  const secretId = options.secretId ?? `psd-agent/${options.environment}/invocation-signing-key`
  // Imported lazily so the AGENT_INVOCATION_SIGNING_SECRET path — the one used
  // against a local broker — needs nothing from node_modules.
  const { GetSecretValueCommand, SecretsManagerClient } = await import(
    "@aws-sdk/client-secrets-manager"
  )
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" })
  const secret = await client
    .send(new GetSecretValueCommand({ SecretId: secretId }))
    .then((result) => result.SecretString ?? "")
    .catch((error: unknown) => {
      throw new Error(
        `Could not read the invocation signing secret "${secretId}": ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          `Check your AWS credentials/region, or set AGENT_INVOCATION_SIGNING_SECRET directly.`
      )
    })
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(`Signing secret "${secretId}" is missing or shorter than 32 bytes`)
  }
  return secret
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const secret = await resolveSigningSecret(options)

  const token = createInvocationContextToken(
    secret,
    {
      actorEmail: options.owner,
      ownerEmail: options.owner,
      mode: options.mode,
      sessionId: options.sessionId,
      // The probe payload sends no workspace_prefix, so the token must not
      // claim one either — the wrapper binds the microVM to what it is given.
      workspacePrefix: "",
    },
    { ttlSeconds: options.ttlSeconds }
  )
  const requestProofKey = deriveInvocationRequestProofKey(secret, token)

  // Reject locally rather than letting the container reject at canary time,
  // where the failure reads as "the image is broken".
  if (!INVOCATION_CONTEXT_RE.test(token)) {
    throw new Error("Minted token does not match the wrapper's accepted shape")
  }
  if (!REQUEST_PROOF_KEY_RE.test(requestProofKey)) {
    throw new Error("Derived request proof key does not match the wrapper's accepted shape")
  }

  const expiresAt = new Date((Math.floor(Date.now() / 1000) + options.ttlSeconds) * 1000)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          invocationContext: token,
          requestProofKey,
          ownerEmail: options.owner,
          sessionId: options.sessionId,
          mode: options.mode,
          expiresAt: expiresAt.toISOString(),
        },
        null,
        2
      )
    )
    return
  }

  // stderr, so `eval "$(...)"` picks up only the exports.
  process.stderr.write(
    `Minted ${options.mode} context for ${options.owner} (${options.environment}), ` +
      `expires ${expiresAt.toISOString()}\n`
  )
  console.log(`export AGENT_PROBE_INVOCATION_CONTEXT='${token}'`)
  console.log(`export AGENT_PROBE_REQUEST_PROOF_KEY='${requestProofKey}'`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
