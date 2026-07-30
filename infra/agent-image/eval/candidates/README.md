# Candidate image matrix

The candidate-image contract builds one comparison image while holding every
axis but one equal to `manifests/baseline.json`. It is intentionally separate
from deployment and promotion: producing an ECR digest does not change the
AgentCore runtime.

## One command

Run from `infra/agent-image` with a clean Git checkout:

```bash
./build-and-push.sh \
  --candidate eval/candidates/manifests/glm-5-native.json \
  2026-07-29-glm-5-native
```

The command validates the manifest and its official-source metadata, runs the
unchanged static gates against the materialized inputs, builds, boots, executes
one real `/invocations` turn, grades the exact `CANDIDATE_OK` output, pushes,
resolves the immutable digest, and writes the local sidecar
`.candidate-builds/<tag>.json`.

The committed model matrix is:

| Manifest | Model | Provider path | Cache |
|---|---|---|---|
| `glm-5-native.json` | Z.AI GLM-5 | native Bedrock Converse + SigV4 | `none` |
| `glm-5-mantle-openai.json` | Z.AI GLM-5 | Mantle OpenAI-compatible | `none` |
| `openai-gpt-oss-120b.json` | OpenAI GPT OSS 120B | Mantle OpenAI-compatible | `none` |
| `kimi-k2-5.json` | Moonshot Kimi K2.5 | Mantle OpenAI-compatible | `none` |
| `qwen3-coder-next.json` | Qwen3 Coder Next | Mantle OpenAI-compatible | `none` |
| `sonnet-5-mantle-anthropic.json` | Claude Sonnet 5 | Mantle Anthropic Messages | `long` |

Issue #1429 adds two non-model calibration arms:

| Manifest | Axis | Candidate |
|---|---|---|
| `openclaw-cli-gateway.json` | Harness | Uses OpenClaw's reserved `cli`/`cli` loopback identity instead of production `gateway-client`/`backend` |
| `conservative-tool-routing.json` | Prompt | Adds minimum-capability and explicit-side-effect routing guidance |

The harness arm exercises the beta's reserved `cli`/`cli` container-local
identity against production's supported `gateway-client`/`backend` loopback
identity. The beta reclassifies TUI as Control UI and requires device identity;
both approved non-UI paths preserve operator scopes after loopback shared-token
auth. Host, plugins, model, config, and materialized prompt remain byte-identical
to baseline.

## Axis contract

Every manifest contains complete `model`, `harness`, and `prompt` axes plus a
`declaredAxis`. `candidate.py` compares those objects to the baseline and
rejects zero changes, an undeclared change, or changes to two or more axes.

- `model` selects one provider template. A template includes the model,
  transport, authentication, endpoint, safe agent context budget, cache mode,
  cost, cost sources, and IAM. The context budget may not exceed the selected
  model's documented context window.
- `harness` pins the immutable OpenClaw base digest, human-readable host
  version, Bedrock plugin version/assertion, and Parallel plugin
  version/endpoint. The generated pin contract is passed through
  `check_config_consistency.py`; each `npm pack` and its tarball references
  share the same build argument. Harness candidates may also declare a
  narrowly allowlisted `configMigrations` list when the new host moves or
  retires baseline keys, plus an exact allowlisted loopback client pair when a
  host requires a different scope-preserving identity. These compatibility
  inputs are part of the harness axis and cannot change model or prompt
  configuration.
- `prompt` selects the SOUL preamble and rules skill. The candidate versions
  are passed as Docker build inputs and checked against the materialized
  config's bootstrap budgets.

The baseline template must compose byte-for-byte to the checked-in
`openclaw.json`. If production changes without a matching baseline update,
every candidate validation fails loudly.

## Provider contracts

All entries below were re-verified against the linked AWS documentation on
2026-07-29.

### Native Bedrock SigV4

- OpenClaw `api`: `bedrock-converse-stream`
- `auth`: `aws-sdk`
- `baseUrl`: `https://bedrock-runtime.us-east-1.amazonaws.com`
- Runtime IAM: `bedrock:InvokeModel` and
  `bedrock:InvokeModelWithResponseStream` on the selected foundation model.
- For a cross-region inference profile, grant both the inference-profile ARN
  and **every** destination-region foundation-model ARN. Organization SCPs
  must permit all of those destination regions. The Sonnet template enumerates
  us-east-1, us-east-2, and us-west-2 member ARN patterns.

Sources: [Bedrock endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html),
[inference-profile prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html),
and [supported cross-region profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html).

### Mantle OpenAI-compatible

- OpenClaw `api`: `openai-completions`
- `auth`: `api-key`
- `baseUrl`: `https://bedrock-mantle.us-east-1.api.aws/v1`
- Credential: `AWS_BEARER_TOKEN_BEDROCK`, loaded from the stack's
  `BedrockApiKeySecretArn` for the candidate probe. The root-owned loopback
  relay injects it into the fixed AWS request; the node gateway receives only
  a non-secret sentinel and cannot read the bearer or secret ARN.
- IAM for the key-backed Mantle API:
  `bedrock-mantle:CallWithBearerToken` requires
  resource `*`; the probe principal also needs `secretsmanager:GetSecretValue`
  on that one environment secret. Model access should be constrained with a
  Bedrock project/API-key policy when this path is used beyond a local
  candidate.

Sources: [Mantle APIs](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html),
[API-key authentication](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html),
and [API-key permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-permissions.html).

### Mantle Anthropic Messages

- OpenClaw `api`: `anthropic-messages`
- `auth`: `api-key`
- `baseUrl`: `https://bedrock-mantle.us-east-1.api.aws/anthropic`; OpenClaw
  appends `/v1/messages`.
- Credential/IAM: the same root-relayed API key and
  `bedrock-mantle:CallWithBearerToken`
  contract as the OpenAI-compatible path.

Source: [Bedrock Mantle Messages API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html).

## Model limits, cost, and caching

Costs are USD per one million tokens in US East standard/on-demand service.
Every numeric cost field in a provider template has its own `costSources`
entry, and validation fails if a field or source is missing.

| Model | Context / max output | Input / output | Cache read / write |
|---|---:|---:|---:|
| Claude Sonnet 5 | operational 200K / 32K | $3 / $15 | $0.30 / $6 |
| GLM-5 | 200K / 128K | $1 / $3.20 | $0 / $0 |
| GPT OSS 120B | 128K / 16K | $0.15 / $0.60 | $0 / $0 |
| Kimi K2.5 | 256K / 16K | $0.60 / $3 | $0 / $0 |
| Qwen3 Coder Next | 256K / 16K | $0.50 / $1.20 | $0 / $0 |

The baseline keeps the repository's deliberate 200K/32K operational cap for
Claude even though the current model card advertises a larger service maximum.
Non-Claude candidates must set `cacheRetention: none`; validation rejects any
other value and the existing prompt-cache consistency gate remains in force.

Sources: [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/),
[Claude Sonnet 5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html),
[GLM-5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-5.html),
[GPT OSS 120B](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html),
[Kimi K2.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html),
and [Qwen3 Coder Next](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html).

## Sidecar fields

The finalized JSON sidecar records:

- candidate and baseline IDs, the varied axis, and both sides of that delta;
- model ID, provider name/path/API/auth/base URL, and cache retention;
- immutable base image, host/plugin pins, Bedrock assertion token, Parallel
  endpoint, prompt variant, and source paths;
- model costs, a source URL for every cost, complete provider source/IAM
  metadata, manifest SHA-256, and AI Studio source commit;
- pushed ECR tag, immutable image digest, preparation time, and finalization
  time.

`.candidate-builds/` is ignored because it is local build evidence. Copy the
sidecar into the issue/PR evidence when reporting the candidate; do not commit
credentials or eval transcripts.

Pass the same finalized sidecar to repeated evaluations:

```bash
python3 infra/agent-image/eval/runner.py \
  --image <immutable-ecr-uri@sha256:digest> \
  --candidate-metadata infra/agent-image/.candidate-builds/<tag>.json \
  --suite infra/agent-image/eval/suites/regression.yaml \
  --out /tmp/candidate-regression.jsonl
```

The runner requires `--image` in immutable `repository@sha256:...` form and
verifies that digest against the sidecar; the mutable tag is evidence only.
Native SigV4 remains a no-secret path. For either Mantle path, it resolves the
environment's `BedrockApiKeySecretArn` stack output and gives the container
only that ARN. The root-owned relay retrieves and injects the key using the
active, refreshed AWS credential chain; the node gateway receives neither.
