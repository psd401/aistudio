# Local agent-image eval runner

`runner.py` boots a candidate image locally and records repeated task results
from the same `/invocations` endpoint AgentCore uses in production. It records
outcomes and telemetry (#1422), injects a hermetic broker for L1 tasks, and
applies deterministic request/output/trajectory graders (#1424).

## Run a suite

From the repository root:

```bash
python3 infra/agent-image/eval/runner.py \
  --image <immutable-ecr-uri@sha256:digest> \
  --candidate-metadata infra/agent-image/.candidate-builds/<tag>.json \
  --suite infra/agent-image/eval/suites/regression.yaml \
  --trials 3 \
  --out /tmp/issue-1426-regression.jsonl \
  --agent-runtime-id <deployed-dev-runtime-id> \
  --owner-email eval.issue1426@psd401.net \
  --name-prefix psd-agent-eval-issue-1426
```

Use `eval/suites/capability.yaml` for the harder daily-driver comparison set.
Passing `--agent-runtime-id` mirrors only the allowlisted, non-secret deployment
fields required by L2 skills (currently HyperFrames and the optional summarize
model override); it never copies the runtime's complete environment.
The legacy `core.yaml` remains the three-task runner/isolation smoke suite.

The runner uses the active AWS credential chain and discovers the dev web
broker from the deployed router Lambda. Set `AGENT_EVAL_APP_BASE_URL` or pass
`--app-base-url` to override discovery. The same credentials must be able to
read `psd-agent/<environment>/invocation-signing-key` so the runner can mint
short-lived invocation authority. The authority TTL is derived from
`--invocation-timeout` with a 60-second safety margin (plus five seconds for
issuance rounding), up to the verifier's 7,200-second limit. The active
credential chain is re-resolved for both context minting and the candidate
container before every trial, after any container boot, and after context
minting immediately before invocation. If temporary credentials rotate, a
shared pure-task container is recycled with the new values; credentials that
cannot outlive the configured invocation timeout fail closed before the trial
starts. Temporary credentials carrying a session token must also report their
expiration; manually exported temporary triples with unknown lifetime are
rejected rather than risking a mid-trial expiry.
Automation providers that export temporary credentials without provider-chain
expiration metadata must set `AGENT_EVAL_AWS_CREDENTIAL_EXPIRATION` to their
ISO 8601 expiry. The weekly workflow obtains that value directly from the OIDC
credential action's `aws-expiration` output.
When a post-mint credential check recycles the runtime, the runner discards
that authority and remints it for the ready container before invoking.

Every run requires an immutable `repository@sha256:...` image reference, even
when `--candidate-metadata` is omitted. Mutable local or ECR tags are rejected
before Docker starts so results cannot be attributed to moving image bytes.
Candidate-matrix runs must pass the finalized `.candidate-builds/<tag>.json`
sidecar. The runner requires the sidecar's immutable digest as `--image` and
rejects even its matching mutable tag. Native SigV4 metadata causes no
provider-secret lookup. For Mantle OpenAI/Anthropic metadata, the runner resolves
`BedrockApiKeySecretArn` from the selected environment's agent-platform stack
and passes only that ARN into each short-lived container. The root-owned relay
reads the value with the same refreshed AWS credential chain and injects it
only into the fixed AWS model request; the node gateway cannot read it. The
caller therefore needs `secretsmanager:GetSecretValue` on that environment
secret for Mantle evaluations.

Owner-bound skill tasks must pass an eval-only address on the real PSD domain
with `--owner-email` (or `AGENT_EVAL_OWNER_EMAIL`). The signed context makes
that address the trial's actor and owner, so the model exercises the same
anti-impersonation rule as production. Use a synthetic address dedicated to
the run, never another staff member's identity. L1 fixtures intercept the
resulting broker operation before any owner credential or live side effect is
used.

JSONL output is created with owner-only (`0600`) permissions because complete
metadata can contain prompts, messages, and tool details. Keep it in an
issue-specific temporary path; do not commit run transcripts.

## Build a reproducible candidate image

The one-axis candidate matrix lives under `eval/candidates/`. From
`infra/agent-image`, build and push a selected candidate with:

```bash
./build-and-push.sh \
  --candidate eval/candidates/manifests/glm-5-native.json \
  2026-07-29-glm-5-native
```

`candidate.py` compares the full model/provider, harness, and prompt axes to
`manifests/baseline.json` and requires exactly the declared axis to differ. It
then materializes the config and prompt, validates the effective host/plugin
pins and cache behavior with the existing consistency gate, and leaves the
Dockerfile's default Sonnet/native-SigV4 behavior unchanged.

Before push, the candidate must boot and pass one exact-output graded turn.
After push, `.candidate-builds/<tag>.json` binds the immutable digest to its
model ID, provider path, harness and plugin pins, prompt variant, cache mode,
axis delta, cost sources, and source commit. That local sidecar is comparison
evidence and the runner's provider-auth contract, not a deployment instruction.

See [`candidates/README.md`](./candidates/README.md) for the complete
OpenAI/GLM/Kimi/Qwen/Claude manifest matrix and the verified native Bedrock,
Mantle OpenAI-compatible, and Mantle Anthropic Messages contracts.

## Transcript-free summaries

After both production suites finish, convert their JSONL records into the only
run artifact that is safe to commit:

```bash
docker run --rm --platform linux/arm64 \
  --name psd-agent-eval-issue-1427-config \
  --entrypoint cat \
  <immutable-ecr-uri@sha256:digest> \
  /home/node/.openclaw/openclaw.json \
  > /tmp/issue-1427-openclaw.json

IMAGE_SOURCE_COMMIT="$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  <immutable-ecr-uri@sha256:digest>)"

python3 infra/agent-image/eval/summarize.py \
  --records /tmp/issue-1427-regression.jsonl \
  --records /tmp/issue-1427-capability.jsonl \
  --image <immutable-ecr-uri@sha256:digest> \
  --source-commit "${IMAGE_SOURCE_COMMIT}" \
  --source-commit-provenance image-label \
  --eval-harness-commit "$(git rev-parse HEAD)" \
  --model-config /tmp/issue-1427-openclaw.json \
  --out .eval-runs/sha256-<digest>.json \
  --require-all-pass
```

`source_commit` is the evaluated image's AI Studio revision, read from the
immutable image config; `eval_harness_commit` is the checkout that supplied the
runner, suites, graders, and summarizer. `build-and-push.sh` refuses dirty
agent-image sources and stamps both the AI Studio source repository and full
revision into the image. This keeps a delayed deployment from being attributed
to the workflow's newer checkout. The initial baseline predates those labels;
its `legacy-image-tag` provenance records the full revision embedded in the
image's build tag rather than pretending the inherited OpenClaw revision label
describes AI Studio.

The summary contains per-task and per-skill `pass^3`, aggregate token usage,
duration and latency distributions, model-call counts, nudge rate, failure
classes, failed-grader counts, and caching status. When usage is complete, cost
uses the primary model's `openclaw.json` price block; automation extracts that
file from the exact immutable image so a repo/image skew cannot silently
misprice a run. Each new trial carries an explicit `usage_capture_complete`
flag from the selected proxy or transcript source. A false or legacy-missing
flag makes its containing scope incomplete: its caching status is `unknown`
and its cost fields are null. Completeness is evaluated per trial so fallback
output or usage captured by another trial cannot mask a telemetry gap. The
transcript source sets the flag only after an explicit `stop` or `end_turn`;
missing or novel stop reasons remain incomplete. Committed-artifact validation
also rejects a known overall status when any complete suite or skill partition
is unknown.
Otherwise, zero `cache_read_input_tokens` means `uncached`.

New runner records capture the actual invocation start before any container or
trial work. The first baseline predates that field, so its summary explicitly
marks `started_at` unavailable and separately reports the first trial-record
timestamp instead of presenting that completion timestamp as the run start.

It never retains prompts, results, messages, tool-call arguments, session IDs,
broker requests, or grader reasons. `.gitignore` blocks JSONL/capture/raw files
under `.eval-runs/`, and CI additionally validates every field against a
recursive allowlisted schema from the Git index. Unknown keys are rejected, so
a forced `git add` or a newly named transcript/secret field cannot bypass the
guard:

```bash
python3 infra/agent-image/eval/summarize.py --check-repository
```

Committed summary filenames use `sha256-<64 lowercase hex>.json`; the file
itself records the full immutable ECR URI and digest.

## Compare two summaries

`report.py` compares two schema-valid, digest-named summaries. It requires the
same `eval_harness_commit`, task IDs, skill ownership, suite classification, and
trial count in both arms so a harness or task-set change cannot masquerade as a
model improvement:

```bash
python3 infra/agent-image/eval/report.py \
  .eval-runs/sha256-<baseline-digest>.json \
  .eval-runs/sha256-<candidate-digest>.json
```

The terminal report sorts the per-skill `pass^3` table by regression severity,
then shows aggregate cost, duration, latency, model-call, nudge, and runtime
failure-class deltas. Any task whose passed-trial count changed is shown as,
for example, `2/3 (FAIL) -> 3/3 (PASS)`. The report does not invent confidence
intervals from three trials.

The promotion verdict implements the epic's three clauses independently:

1. no skill's regression-suite `pass^3` rate drops below its baseline;
2. overall capability-suite `pass^3` strictly improves; and
3. cost per task increases by no more than 20%.

Clause (3) and the report's total/per-task cost deltas reconstruct unrounded
Decimal costs from each arm's stored token totals and model price block. The
six-decimal summary cost remains a display value only, so two tiny real costs
that both round to zero cannot accidentally pass the promotion gate or produce
a contradictory `0.00%` report delta. Any exact increase above the 20% limit
also carries an explicit `over 20% limit` marker, even if its two-decimal
percentage display rounds to `20.00%`.

Caching status is schema-validated against observed output-token, model-call,
and cache-read counts, not candidate configuration. When an arm's usage is
incomplete, its cache and cost render as `unknown`; when only one complete arm
observed cache reads, both raw costs remain visible but their delta is not
compared. In either case clause (3) is marked `DECLINED`, and the result can
never be `PROMOTE`. A quality-clause failure still produces `REJECT`, while
otherwise passing quality with an unavailable cost verdict produces
`INDETERMINATE`.

Render the same evidence as Markdown for a recorded comparison decision:

```bash
python3 infra/agent-image/eval/report.py \
  .eval-runs/sha256-<baseline-digest>.json \
  .eval-runs/sha256-<candidate-digest>.json \
  --format markdown \
  --out .eval-runs/comparison-sha256-<baseline-digest>-vs-sha256-<candidate-digest>.md
```

Markdown under `.eval-runs/` is accepted by the repository guard only with
that digest-pair filename and only when its bytes exactly match a report
regenerated from the two tracked summaries. Arbitrary Markdown, hand-edited
reports, nested artifacts, and transcript-like files remain rejected.

By default, reporting a rejected candidate succeeds so its evidence can be
recorded. Add `--require-promotion` in an enforcement step to exit with status
1 for `REJECT` or `INDETERMINATE`. Invalid or incomparable summaries exit with
status 2.

## Nightly and on-demand runs

`.github/workflows/agent-eval-nightly.yml` runs all 53 regression and capability
tasks at three trials nightly on an ARM64 runner. It resolves the immutable
image currently exposed by the dev AgentCore runtime, verifies its AI Studio
source labels, uploads only the safe summary, removes both JSONL transcripts
even on failure, and fails when any task misses `pass^3`. It has no
`pull_request` or `push` trigger and therefore is not part of the PR gate.

Dispatch the same run on demand from GitHub Actions:

```bash
gh workflow run agent-eval-nightly.yml --ref dev
```

The workflow uses the repository's `AGENT_EVAL_AWS_ROLE_ARN` OIDC role and the
dedicated synthetic owner `eval.nightly@psd401.net`. Both scheduled and manual
runs resolve the exact immutable digest exposed by the deployed dev runtime;
mutable tags fail before Docker starts.

Resolved short-lived AWS credentials are passed into the candidate container's
environment and are therefore visible to users with access to the local Docker
daemon (for example through `docker inspect`). They are also briefly present in
the `docker run` process arguments and may be visible to local process-inspection
tools while the container starts. Run evals only on a trusted workstation. The
runner removes its containers on completion and logs a warning if Docker cannot
remove one.

OpenClaw 2026.7.1 deliberately removes inherited AWS access-key and container-
credential variables from model-launched `exec` subprocesses. Direct-AWS skills
therefore use the image's root-owned fixed-operation relay: the relay inherits
the candidate container's credential chain, while the skill process receives
only the requested Polly audio or HyperFrames result and never reusable
credential material. The TTS and HyperFrames L2 tasks cover this exact boundary.

Every trial gets:

- a fresh UUID in `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`;
- a signed context minted for that exact UUID immediately before invocation;
- one JSONL record containing the task's suite classification, raw result, and
  complete final-event metadata.

`workspace: pure` tasks share one container while retaining conversational
isolation through fresh session IDs. `workspace: mutating` tasks boot a fresh
container for every trial so local files and memory cannot leak.

`level: L1` tasks replace the image's `/app/mantle_proxy.py` at runtime with a
read-only bind mount of `eval/broker_stub.py`. The candidate image is not
modified. A root-owned `0700` in-container tmpfs carries only the active trial's
fixtures and `0600` request capture; the runner installs and collects that state
through root-only Docker execs, so the image's `node` user cannot read fixtures
or forge grader inputs even when its numeric UID matches the host runner. The
stub implements the same 16 fixed `/api/agent/*` routes as `agent-broker.js` and
`mantle_proxy.py`, plus the health, usage, and finalization endpoints the wrapper
needs. It also preserves the fixed `/anthropic/v1/messages` loopback endpoint
used by `psd-summarize`, relaying only that model path to the trusted web tier
with root-held invocation authority. Finalization drains already-active broker
and summarization requests and rejects new work before acknowledging the
boundary. The wrapper's end transition leaves the stub closed through runner
capture collection; installing the next trial uses a separate root-only token
to reopen it, so delayed work cannot spill across trials. L0 and L2 tasks
retain the image's real proxy; pure live and stubbed tasks use separate
containers.

## Task and suite files

Task files use a flat, dependency-free YAML subset. Double-quoted
scalars and inline lists/maps use JSON-compatible syntax. Single-quoted scalars
use YAML escaping, so an apostrophe is written twice (`'Don''t use tools'`).
Trailing inline comments are not part of this subset; use their own `#` line.

```yaml
id: arithmetic-no-tools
skill: runner-core
level: L0
workspace: pure
suite: regression
prompt: "Without using tools, calculate 17 times 19."
trials: 3
```

A suite contains relative task paths. Production eval tasks live beside their
skills under `skills/<skill>/evals/`; suite entries may point there:

```yaml
tasks:
  - ../../skills/chat-card/evals/ticket-confirmation.yaml
  - ../../skills/psd-directory/evals/email-exact-match.yaml
```

Every production task declares `suite: regression` or `suite: capability`.
Regression tasks should remain at or near 100%; capability tasks are harder
comparisons. The classification is preserved in every JSONL record. The
committed `core.yaml` suite has three unclassified L0 smoke tasks; its
seed/recall pair checks that a passphrase stated under one session is unknown
under the next.

### Coverage inventory and drift gate

Coverage follows the final image inventory rather than a hard-coded epic
count. The checked-in tree contains 32 directories with `SKILL.md`; 31 have
one or more co-located tasks and `psd-rules` is a documented opt-out. `_shared`
is not a skill because it has no `SKILL.md`.

`psd-rules` is concatenated into `SOUL.md` at image build time. It is global
bootstrap policy, not an independently invoked skill, so assigning it an
invocation task would falsely imply a callable boundary. Its behavior is
exercised transitively by every task.

The image build also adds 44 pinned `gws-*` guidance skills from
`googleworkspace/cli`. They are documentation-only aliases: direct `gws`
execution is disabled by `gws-wrapper.sh`, and the executable behavior is
covered through `psd-workspace`. Their names and shared opt-out reason live in
`eval/upstream-skill-inventory.json`. The drift gate requires the manifest's
version to match Dockerfile `GWS_VERSION`. A dedicated path-filtered and weekly
CI workflow shallow-clones that exact release and compares its
`gws-*/SKILL.md` directory set with the manifest, without adding a network
dependency to unrelated application PRs. Changing the pinned upstream release
therefore requires reviewing the actual shipped skill inventory rather than
only updating version strings.
Together, the final image inventory is 76 skills: 31 directly evaluated and
45 explicitly opted out (`psd-rules` plus the 44 documentation-only `gws-*`
skills).

Run the offline inventory check used by the main CI job:

```bash
python3 infra/agent-image/check_eval_coverage.py
python3 -m unittest infra/agent-image/test_eval_coverage.py
```

The check fails when any new checked-in skill lacks an `evals/*.yaml` file or
when any build-added skill is absent from the documented upstream opt-out
inventory. The test suite also creates a fixture skill without `evals/` and
proves that the failure fires. Stale or reasonless opt-outs and upstream pin
drift fail as configuration errors.

Run the path-filtered/scheduled upstream release comparison locally with:

```bash
python3 infra/agent-image/check_eval_coverage.py --verify-upstream
```

The regression and capability manifests contain 53 tasks total. At least 25%
are explicit negative cases: they prove that a route or side effect is not
used, rather than treating non-invocation as an unobserved success.

### Level policy

Use the lowest hermeticity level that exercises the real skill boundary:

| Level | Contract | Current uses |
|---|---|---|
| L0 | No external network or live service | Local renderers/converters, bundled references, offline self-checks, and policy/clarification tasks |
| L1 | All service traffic crosses the loopback broker and is fixture-backed or asserted absent | AI Studio, Atrium reads, Canva reads, credentials, data MCP, directory, email triage, Freshservice, GitHub, Plaud, schedules, skills catalog, workflow gateway, Workspace |
| L2 | A required provider, AWS API, or out-of-band upload cannot be represented by the broker fixture contract | Native `web_search`, QuickChart, failure-report CloudWatch emission, HyperFrames Lambda, positive image generation/upload, keyless web research, records-safe model summarization, Polly/audio upload |

Some skills support more than one level. `psd-html-artifact` is L0 when its
`--audit-only` gate is evaluated, but a delivery task is L2 because the
presigned `PUT` is outside the broker capture. `psd-learning-page` has an L0
contract task; a full publish is L2 because it composes TTS, video rendering,
and Atrium. `psd-image-gen` has an L1 fail-closed capability task; a positive
generation remains L2 because artifact delivery uses a presigned `PUT` outside
the broker capture. `psd-data` is L1 in the current image: its MCP transport now
crosses the owner-bound credentials broker, despite older design notes
describing a direct Lambda URL.

Regression tasks pin stable routing, safety, and output contracts. Capability
tasks deliberately require more judgment or generation and are the comparison
surface where model changes may improve. A task belongs in regression only
when the current baseline should reliably pass it 3/3.

### Weekly live-dev fixture-drift run

`.github/workflows/agent-eval-l2.yml` runs `l2-live.yaml` every Tuesday and on
manual dispatch. It requires the immutable image digest exposed by the dev
AgentCore runtime (or accepts an explicit ECR digest for manual runs), executes
three trials per task on an ARM64 runner, and fails unless every trial passes.
Mutable tags are rejected because AgentCore does not expose which digest a tag
resolved to at deployment time.

The workflow uses `canary@build-gate.invalid`, the existing RFC 2606 disposable
owner identity. Every live prompt is labeled `EVAL-1426` or synthetic. The
subset is intentionally small:

- native `web_search` verifies the configured key-free provider returns cited
  results instead of a provider-unavailable error;
- QuickChart and recent-source research use synthetic/public inputs;
- summarization uses fabricated PII to verify exclusion;
- TTS uploads only the phrase `EVAL 1426 synthetic audio canary`.

The L2 failure-report task remains in the regression suite but is excluded
from this weekly subset: it requires an `@psd401.net` actor for attribution,
which the RFC 2606 canary intentionally is not.

Repository secret `AGENT_EVAL_AWS_ROLE_ARN` must name a least-privilege OIDC
role able to read the deployed runtime and ECR image, pull that image, discover
the dev broker, mint signed probe authority, and perform the listed L2 calls.
The role must permit a three-hour session, matching the workflow's requested
duration.
Until #1440 is fixed, the retained Summarize canary is expected to fail and
should be treated as a known defect signal, not workflow misconfiguration. TTS
now gates the fixed-operation credential boundary from #1442. HyperFrames
exercises the same boundary and is omitted from the weekly subset to avoid a
duplicate live side effect.
The workflow never uploads or commits JSONL transcripts. It prints only task
IDs and failure reasons, then deletes the owner-only run file even on failure.

## L1 fixtures and graders

An L1 task names one or more relative JSON fixture files and at least one
grader. Graders use inline JSON objects so the runner's dependency-free YAML
subset stays unambiguous:

```yaml
id: directory-lookup
skill: psd-directory
level: L1
workspace: pure
suite: regression
prompt: "Find Ada in the staff directory."
trials: 3
fixtures:
  - fixtures/directory-lookup.json
graders:
  - {"type":"broker_request","route":"/api/agent/directory-lookup","method":"POST","body":{"query":{"exact":"Ada"}}}
  - {"type":"no_route_called","route":"/api/agent/email-triage"}
  - {"type":"trajectory_in_order","tools":["skills.search","directory.lookup"]}
  - {"type":"tools_catalog","expected":["skills.search","directory.lookup"]}
  - {"type":"output_match","pattern":"Ada","ignore_case":true}
```

A fixture file is a list (or an object containing a `fixtures` list):

```json
[
  {
    "route": "/api/agent/directory-lookup",
    "method": "POST",
    "request_body": {"query": "Ada"},
    "response": {
      "status": 200,
      "body": {"people": [{"name": "Ada Lovelace"}]}
    }
  }
]
```

`request_body` is an optional recursive partial-object selector. Mapping keys
may address list positions (for example, `"argv": {"4": "--params"}`), and a
mapping selector applied to a JSON-string value matches its decoded fields.
Use `{"$text_equals": "..."}` when plain text must match exactly after trimming
transport whitespace. Use `{"$matches_any": [{...}, {...}]}` to enumerate
fully specified alternate request shapes. A request to an allowlisted route
without a matching fixture returns a named
`EvalFixtureMissing` response and automatically fails the trial; it never
falls through to a live service or a silent empty response.
Broker operations mirror production: fixtures and requests must use `POST`,
request bodies must be JSON objects, and fixture responses must use a final
HTTP status in the range 200-599. Fixture files plus the
`broker_request` and `no_route_called` graders require `level: L1`; live L0/L2
tasks reject them instead of grading an empty capture.

Available graders:

- `broker_request` matches route/method and optional body fields. Body matchers
  are `exact`, `contains_any`, `json_contains`, `matches_any`,
  `numeric_equals`, and `text_equals`; dot paths address nested fields.
  `json_contains` parses a JSON string and recursively matches the declared
  subset. `matches_any` accepts a non-empty list of recursive selectors for
  explicitly supported request shapes. `text_equals` ignores leading/trailing
  transport whitespace but otherwise requires exact text.
- `no_route_called` asserts the selected route/method received no request. It
  accepts the same optional `body` matchers as `broker_request`, which lets a
  task forbid a send operation while permitting a draft on the shared
  `/api/agent/workspace-execute` route.
- Broker grader routes must be in the production agent-broker allowlist; an
  explicit method must be `POST`.
- `output_match` applies a regular expression to the final result.
- `quickchart_image` is an L2-only provider probe. It accepts only an exact
  `https://quickchart.io/chart` image URL from a parsed rich-card envelope,
  verifies the encoded chart type, title, labels, and values against the task
  declaration, refuses redirects, and then requires HTTP 200, `image/png`, and
  the PNG signature. This closes the gap where a correct prose URL could mask a
  stale card URL, or a fabricated URL/QuickChart outage could satisfy an
  envelope-only assertion.
- `tool_call_succeeded` requires a tool invocation whose arguments match the
  declared regular expression and a successful completion status. It supports
  both current single-record telemetry and the legacy split completion shape.
  This prevents a manually produced fallback from masking a failed skill
  executable.
- `trajectory_in_order` requires relative tool order while allowing extra
  intervening steps.
- `tools_catalog` checks the per-turn compact, complete `tools.catalog` name
  diagnostic for every expected entry.

Each JSONL record includes `broker_requests` plus a `grade` object containing
the per-grader boolean and human-readable reason. Task reliability uses
`pass^k`: all `k` trials must pass. Two successes out of three is a failed
`pass^3`.

## Hermetic tests

```bash
UV_CACHE_DIR=/tmp/issue-1426-uv-cache \
  uv run --python 3.12 --no-project -m unittest \
  infra/agent-image/test_harness_adapter.py \
  infra/agent-image/test_agentcore_wrapper.py \
  infra/agent-image/test_iteration_telemetry.py \
  infra/agent-image/test_mantle_proxy.py \
  infra/agent-image/test_mantle_proxy_logging.py \
  infra/agent-image/test_check_bootstrap_budget.py \
  infra/agent-image/test_check_config_consistency.py \
  infra/agent-image/test_candidate_matrix.py \
  infra/agent-image/test_workspace_sync.py \
  infra/agent-image/test_chat_format.py \
  infra/agent-image/test_artifact_publisher.py \
  infra/agent-image/test_eval_coverage.py \
  infra/agent-image/test_broker_stub.py \
  infra/agent-image/test_graders.py \
  infra/agent-image/test_eval_runner.py \
  infra/agent-image/test_eval_summary.py \
  infra/agent-image/test_report.py
```

The tests make no AWS, model, Docker, or external-network calls. Broker HTTP
tests bind only an ephemeral loopback port.
