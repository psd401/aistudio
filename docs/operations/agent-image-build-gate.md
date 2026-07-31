# Agent Image Build-Time Eval Gate (#1161)

`infra/agent-image/build-and-push.sh` refuses to push an agent image that has
not been proven to boot and answer. This page documents the gate's eight checks,
how to satisfy the runtime half, and how to override it when you must.

The gate exists because the image is an artifact optimised against an
evaluator, and five separate regressions reached production before it did:
a dead-boot image (r10), a missing provider (r11), a silently truncated
`SOUL.md`, a broker/image path-policy mismatch that made populated workspaces
unrestorable, and generated `exec-approvals.json` host state restored as user
history. Every one of them is caught before push by the checks below.

## The eight checks

| # | Check | Kind | Fails on |
|---|-------|------|----------|
| 1 | Instruction-budget (`check_bootstrap_budget.py`) | static | a bootstrap file that would be truncated at boot |
| 2 | Config self-consistency (`check_config_consistency.py`) | static | bad `contextWindow`, `apiKey` hydration, plugin compatibility, web-search readiness, a stale host schema, or a host missing settled-tool finalization in `openclaw.json` / `Dockerfile` |
| 3 | Cross-language workspace persistence contract | static | the Python sync/runtime tests or TypeScript broker integration tests fail |
| 4 | Existing dev + prod workspace inventory | AWS read-only | any registered workspace contains durable state the candidate cannot round-trip, the real TypeScript/Python classifications or generation hashes disagree, or any bucket object would retire a non-generated exec-approval policy / interrupted claim |
| 5 | Plugin-aware config validation | build | the complete config is invalid after the pinned custom plugins are installed |
| 6 | Restored host-state contract | runtime | the image would restore retired exec-approval JSON, bakes that state into the image, or lacks canonical SQLite state |
| 7 | Boot probe | runtime | no `BOOT_OK` within `PROBE_BOOT_TIMEOUT` (default 120s) |
| 8 | Canary turn | runtime | `/invocations` does not answer `OK` |

Static checks run before the build. Plugin-aware validation runs inside the
image after the official Bedrock and Parallel plugins are installed. The
runtime checks run against the freshly built image, before `docker push`.
Check 6 is hermetic: it reads the exact policy staged into the image, verifies
both the retired source and interrupted-Doctor claim are excluded, verifies
neither is baked into the image, contaminates the image workspace with both a
file and directory form, proves the warm-runtime cleanup removes them, and
requires the canonical OpenClaw SQLite state. The static checkpoint regression
also loads a real pre-policy v2
manifest and proves normalization retains every durable entry and both owner
objects without copying or deleting workspace data.
The inventory gate reads the authoritative workspace-prefix registries and
every current S3 key in both dev and prod, including orphaned workspace
prefixes. It rejects incompatible durable state, then sends the same in-memory
inventory through the actual Python image classifier and generation
implementation and compares those results with the actual TypeScript broker.
For the two retired exec-approval paths it bounded-reads the exact listed ETag,
never logs the body or token, and permits only the pinned runtime's generated
socket-only shape (empty defaults and empty agents). Any malformed body,
policy, allowlist, unknown field, changed object, or interrupted Doctor claim
fails closed. Excluded dependency/runtime trees are counted but do not block a
build merely because they contain a path neither runtime restores. The gate
emits aggregate counts and stable hashes only, performs no writes, and cannot
be bypassed by `SKIP_STATIC_GATE=1`. This closes the gap where an empty canary
passed while a normal filename already present in saved user history could not
be restored.
It also fails on any legacy v1 or unknown checkpoint-control object. The
paused cutover runs the same audit after all old writers drain and once more
after deleting the old Runtime, closing both the build-to-deploy gap and the
old wrapper's final shutdown-write window.

Issue #1469 added a fail-closed host contract to check 2. The pinned OpenClaw
runtime must contain its one-shot, tools-disabled finalization for a settled
post-tool turn with no visible answer, plus the structured
`settled post-tool turn lacked a final answer` diagnostic. The Docker build
greps the compiled runtime for both the diagnostic and the no-repeat
continuation prompt; version comments alone are not accepted as proof.
The same static gate rejects the beta.5-retired
`gateway.controlUi.allowInsecureAuth` key and requires semantic memory at its
canonical `memory.search` location, so host/config migrations fail before the
Docker validator.

The plugin-aware build gate also runs `openclaw plugins inspect --runtime` for
the vendored Bedrock and Parallel plugins. Both must report `loaded` at the
exact pins. This is deliberately stronger than `peerDependencies`: Bedrock
plugin 2026.7.1 advertised a range that included the beta.5 host but imported a
plugin-SDK export that host had removed.

## Why the runtime half needs a signed context

Before PR #1353 the production probe handed the container a Bedrock API key
secret and let it call the model directly. The default production image no
longer does: **its native Bedrock provider receives no provider secret** and
signs direct Bedrock calls with the probe/execution role. Privileged broker
calls go through `APP_BASE_URL/api/agent/model-proxy`, which authorizes each
request from two things the router Lambda normally supplies:

- **`invocation_context`** — a short-lived HMAC-signed token binding
  actor / owner / mode / session / workspace-prefix / expiry
  (`infra/lambdas/agent-router/invocation-context.ts`).
- **`invocation_request_proof_key`** — a key derived from that token's nonce,
  used to sign each individual broker request.

Both are required. `agentcore_wrapper.py`'s `_install_invocation_authority()`
rejects the turn if either is missing or malformed, and
`verifyAgentInvocationContext()` (`lib/agent-workspace/invocation-context.ts`)
re-verifies both at the broker.

The signing key lives in Secrets Manager at
`psd-agent/<env>/invocation-signing-key`. The AgentCore execution role is
explicitly **denied** read access to it (`DenyInvocationSigningSecret` in
`infra/lib/agent-platform-stack.ts`), which is the whole point: prompt-driven
code inside the container cannot forge another owner. A developer's own AWS
credentials *can* read it, which is what makes a local probe possible.

## Running the gate

### The short version

```bash
cd infra/agent-image
./build-and-push.sh 2026-07-27-my-change
```

That is usually all you need. When `AGENT_PROBE_APP_BASE_URL` and
`AGENT_PROBE_INVOCATION_CONTEXT` are unset, the script:

1. reads the broker origin from the deployed router Lambda's `APP_BASE_URL`
   (via the stack's `RouterLambdaArn` output), and
2. mints a fresh 15-minute canary context by running
   `scripts/agent-workspace/mint-agent-probe-context.ts`.

Both steps need AWS credentials for the target environment. The inventory gate
also needs read access to the dev and prod user registries and workspace
buckets. If any lookup or audit fails, the build **stops**.

### Building a one-axis candidate

Candidate manifests use the same command and all eight gates:

```bash
cd infra/agent-image
./build-and-push.sh \
  --candidate eval/candidates/manifests/glm-5-native.json \
  2026-07-29-glm-5-native
```

The candidate path validates that exactly one of model/provider, harness, or
prompt differs from the committed baseline. The Dockerfile defaults are still
the production Sonnet/native-SigV4 inputs; the selected config, immutable host
digest, provider-plugin version/assertion, and prompt paths arrive only as
candidate build arguments.

Candidate canaries are deterministic graded turns: the prompt requests exactly
`CANDIDATE_OK`, the extracted final result must fully match, and the probe
artifact records `"grader":"output_match"` plus `grade_passed`. After push, the
command resolves the ECR digest and writes
`infra/agent-image/.candidate-builds/<tag>.json`, binding that digest to the
model/provider path, harness pin, prompt variant, cache mode, varied axis,
source commit, and cited costs.

Native candidates use the active AWS credential chain. Mantle candidates
explicitly opt into the stack's `BedrockApiKeySecretArn`; the root-owned
loopback relay fetches and injects that API key only into the fixed AWS model
request. OpenClaw receives a non-secret sentinel and cannot read either the
bearer or secret ARN. The checked-in native production config contains no
API-key placeholder, so this relay configuration is a strict no-op on the
default build.

See
[`infra/agent-image/eval/candidates/README.md`](../../infra/agent-image/eval/candidates/README.md)
for the complete OpenAI/GLM/Kimi/Qwen/Claude matrix, provider API/auth/base URL
contracts, IAM and cross-region ARN requirements, caching rules, and official
cost sources.

## Running the repeated local eval

The build gate's SSE/payload helpers are also used by
`infra/agent-image/eval/runner.py`. The runner extends the one-shot canary into
an N-task × K-trial local Docker run while leaving the build-probe artifact
schema unchanged:

```bash
python3 infra/agent-image/eval/runner.py \
  --image <immutable-ecr-uri@sha256:digest> \
  --candidate-metadata infra/agent-image/.candidate-builds/<tag>.json \
  --suite infra/agent-image/eval/suites/core.yaml \
  --trials 3 \
  --out /tmp/agent-eval-core.jsonl
```

Every runner invocation requires an immutable `repository@sha256:...` image,
including runs without candidate metadata. The finalized sidecar additionally
makes provider authentication fail closed: `--image` must match its immutable
digest (the matching mutable tag is rejected);
native SigV4 candidates receive no provider secret; Mantle candidates resolve
the environment stack's `BedrockApiKeySecretArn` and pass only that ARN to the
short-lived eval container's root relay.

Pure tasks share a booted container but receive a fresh AgentCore session UUID
and freshly minted signed context on every trial. Workspace-mutating tasks get
a fresh container per trial. The context TTL tracks the configured invocation
timeout with a safety margin, and the same freshly resolved AWS credential
chain is used for context minting and the candidate container. See
`infra/agent-image/eval/README.md` for the task format and complete options.

### Minting a context by hand

Useful when building against an environment other than the one your default
credentials point at, when you want a longer TTL, or when debugging a probe
failure:

```bash
# From the repo root — loads both variables into the current shell
eval "$(bun run --silent agent:probe-context)"

# Then build
cd infra/agent-image
AGENT_PROBE_APP_BASE_URL=https://dev.<your-domain> ./build-and-push.sh my-tag
```

`bun run agent:probe-context` prints two shell exports and a summary line on
stderr:

```
export AGENT_PROBE_INVOCATION_CONTEXT='v1.eyJ2ZXJzaW9u...'
export AGENT_PROBE_REQUEST_PROOF_KEY='kQ7f...'
```

Options (pass after `--`):

| Flag | Default | Notes |
|------|---------|-------|
| `--env <name>` | `$ENVIRONMENT` or `dev` | selects `psd-agent/<env>/invocation-signing-key` |
| `--secret-id <id>` | derived from `--env` | full Secrets Manager id or ARN |
| `--owner <email>` | `canary@build-gate.invalid` | must have a dotted domain — the verifier's `SAFE_EMAIL_RE` rejects bare hostnames |
| `--session <id>` | `probe-<uuid>` | recorded in the token |
| `--ttl <seconds>` | `900` | 30–7200; the verifier caps token lifetime at 2h |
| `--mode <mode>` | `owner` | `owner` \| `consultation` \| `scheduled` |
| `--json` | off | machine-readable output |

`AGENT_INVOCATION_SIGNING_SECRET` short-circuits Secrets Manager entirely —
handy against a local `bun run dev:local` broker whose `.env.local` sets the
same value.

The script signs by importing the router Lambda's own
`createInvocationContextToken()` / `deriveInvocationRequestProofKey()`, so the
token format cannot drift away from what production issues.

### Choosing `AGENT_PROBE_APP_BASE_URL`

The probe container calls the broker over the network, and `mantle_proxy.py`
only trusts an origin that is `https://…`, `http://127.0.0.1…`, or
`http://localhost…`. In practice that means the deployed environment's URL
(`https://dev.<domain>` for dev). A host-run `bun run dev:local` on port 3000 is
**not** reachable as `http://host.docker.internal:3000` — that origin fails the
trusted-broker check.

## Environment variables

| Variable | Effect |
|----------|--------|
| `AGENT_PROBE_APP_BASE_URL` | Broker origin for the probe. Auto-discovered from the router Lambda when unset. |
| `AGENT_PROBE_INVOCATION_CONTEXT` | Signed context token. Auto-minted when unset. |
| `AGENT_PROBE_REQUEST_PROOF_KEY` | Derived request-proof key. Auto-minted alongside the token. |
| `PROBE_BOOT_TIMEOUT` | Seconds to wait for `BOOT_OK` (default 120). |
| `PROBE_CANARY_TIMEOUT` | Seconds to wait for the canary answer (default 120). |
| `CANARY_MESSAGE` | Canary prompt (default `Reply with exactly: OK`; candidate default `Reply with exactly: CANDIDATE_OK`). |
| `PROBE_ARTIFACT_DIR` | Where probe result JSON is written (default `infra/agent-image/.build-probes`). |

### Bypasses

Three separate flags, deliberately not one, so an emergency disables no more
than it must:

| Flag | Disables | When |
|------|----------|------|
| `ALLOW_UNVERIFIED_IMAGE=1` | turns a *skipped* runtime probe from a hard failure into a warning | you cannot reach the broker (no credentials, environment not deployed) and accept an unverified image |
| `SKIP_PROBE_GATE=1` | checks 6–8 entirely, even when they could run | the probe itself is broken and blocking a release |
| `SKIP_STATIC_GATE=1` | checks 1–3 | true emergency only — these are pure file checks with no external dependency; the dev+prod inventory audit still runs |
| `REQUIRE_PROBE_GATE=1` | nothing; **outranks** `ALLOW_UNVERIFIED_IMAGE` | CI, so an opt-in inherited from the environment cannot weaken the pipeline |

`ALLOW_UNVERIFIED_IMAGE=1` does not print "PASSED". It prints:

```
=== Eval gate WAIVED — static checks only; image NOT boot-verified ===
```

and records `"allow_unverified": true` in the probe artifact, so an unverified
image is identifiable after the fact.

## Probe artifacts

Each build writes `infra/agent-image/.build-probes/<tag>.json`:

```jsonc
// verified
{"tag":"2026-07-27-x","boot_ok":true,"boot_elapsed_s":24,"canary_ok":true,"canary_elapsed_s":11}
// verified candidate
{"tag":"2026-07-29-glm","candidate_id":"glm-5-native","boot_ok":true,"boot_elapsed_s":24,"canary_ok":true,"canary_elapsed_s":11,"grader":"output_match","grade_passed":true}
// waived
{"tag":"2026-07-27-x","skipped":true,"reason":"missing_signed_broker_context","allow_unverified":true}
```

These make canary latency trendable across builds, and make it possible to ask
"was this ECR tag ever boot-verified?" after the fact.

## Troubleshooting

**`Could not read the invocation signing secret …`**
Your credentials cannot read `psd-agent/<env>/invocation-signing-key`. Check the
profile/region, or that the environment's `AgentPlatformStack` is deployed.

**Canary answer is `I couldn't verify the identity for this request.`**
`_install_invocation_authority()` rejected the pair. Either the token expired
(mint a fresh one — the default TTL is 15 minutes and the build itself takes
time), or only one of the two variables is set.

**Canary fails with a 403 from the broker.**
The token verified locally but the web tier rejected it: usually a signing-key
mismatch (context minted for `dev`, `AGENT_PROBE_APP_BASE_URL` pointing at
prod), or clock skew beyond 30s between your host and the broker.

**`APP_BASE_URL is not a trusted model broker URL`** in the container logs.
The origin is not `https://` / `127.0.0.1` / `localhost`. See
[Choosing `AGENT_PROBE_APP_BASE_URL`](#choosing-agent_probe_app_base_url).

**Dead boot — `container exited before logging BOOT_OK`.**
A real image defect, which is what the gate is for. `docker logs` output is
echoed above the error; the last 40 lines usually name the failing import or
config key.

## Related

- [`docs/operations/agent-platform-setup.md`](./agent-platform-setup.md) — full
  deploy sequence, including the supply-chain pin refresh (SEC-009).
- `infra/agent-image/build-and-push.sh` — the gate itself.
- `scripts/agent-workspace/mint-agent-probe-context.ts` — the context minter.
- `infra/lambdas/agent-router/invocation-context.ts` — the token format
  (source of truth).
- `lib/agent-workspace/invocation-context.ts` — the verifier.
