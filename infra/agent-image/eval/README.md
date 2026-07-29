# Local agent-image eval runner

`runner.py` boots a candidate image locally and records repeated task results
from the same `/invocations` endpoint AgentCore uses in production. It records
outcomes and telemetry (#1422), injects a hermetic broker for L1 tasks, and
applies deterministic request/output/trajectory graders (#1424).

## Run a suite

From the repository root:

```bash
python3 infra/agent-image/eval/runner.py \
  --image <tag-or-digest> \
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
When a post-mint credential check recycles the runtime, the runner discards
that authority and remints it for the ready container before invoking.

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

Resolved short-lived AWS credentials are passed into the candidate container's
environment and are therefore visible to users with access to the local Docker
daemon (for example through `docker inspect`). They are also briefly present in
the `docker run` process arguments and may be visible to local process-inspection
tools while the container starts. Run evals only on a trusted workstation. The
runner removes its containers on completion and logs a warning if Docker cannot
remove one.

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

Coverage follows the shipped tree rather than a hard-coded epic count. The
current image contains 31 directories with `SKILL.md`; 30 have one or more
co-located tasks and `psd-rules` is the sole documented opt-out. `_shared` is
not a skill because it has no `SKILL.md`.

`psd-rules` is concatenated into `SOUL.md` at image build time. It is global
bootstrap policy, not an independently invoked skill, so assigning it an
invocation task would falsely imply a callable boundary. Its behavior is
exercised transitively by every task.

Run the same inventory check CI runs:

```bash
python3 infra/agent-image/check_eval_coverage.py
python3 -m unittest infra/agent-image/test_eval_coverage.py
```

The check fails when any new shipped skill lacks an `evals/*.yaml` file. The
test suite also creates a fixture skill without `evals/` and proves that the
failure fires. Opt-outs live in `check_eval_coverage.py`; stale or reasonless
entries fail as configuration errors.

The regression and capability manifests contain 50 tasks total. At least 25%
are explicit negative cases: they prove that a route or side effect is not
used, rather than treating non-invocation as an unobserved success.

### Level policy

Use the lowest hermeticity level that exercises the real skill boundary:

| Level | Contract | Current uses |
|---|---|---|
| L0 | No external network or live service | Local renderers/converters, bundled references, offline self-checks, and policy/clarification tasks |
| L1 | All service traffic crosses the loopback broker and is fixture-backed or asserted absent | AI Studio, Atrium reads, Canva reads, credentials, data MCP, directory, email triage, Freshservice, GitHub, Plaud, schedules, skills catalog, workflow gateway, Workspace |
| L2 | A required provider, AWS API, or out-of-band upload cannot be represented by the broker fixture contract | QuickChart, failure-report CloudWatch emission, HyperFrames Lambda, positive image generation/upload, keyless web research, records-safe model summarization, Polly/audio upload |

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
manual dispatch. It resolves the image digest currently deployed to the dev
AgentCore runtime (or accepts an explicit ECR image for manual runs), executes
three trials per task on an ARM64 runner, and fails unless every trial passes.

The workflow uses `canary@build-gate.invalid`, the existing RFC 2606 disposable
owner identity. Every live prompt is labeled `EVAL-1426` or synthetic. The
subset is intentionally small:

- QuickChart and recent-source research use synthetic/public inputs;
- summarization uses fabricated PII to verify exclusion;
- TTS uploads only the phrase `EVAL 1426 synthetic audio canary`;
- failure reporting writes an explicitly labeled synthetic canary record.

Repository secret `AGENT_EVAL_AWS_ROLE_ARN` must name a least-privilege OIDC
role able to read the deployed runtime and ECR image, pull that image, discover
the dev broker, mint signed probe authority, and perform the listed L2 calls.
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
  infra/agent-image/test_eval_coverage.py \
  infra/agent-image/test_broker_stub.py \
  infra/agent-image/test_graders.py \
  infra/agent-image/test_eval_runner.py
```

The tests make no AWS, model, Docker, or external-network calls. Broker HTTP
tests bind only an ephemeral loopback port.
