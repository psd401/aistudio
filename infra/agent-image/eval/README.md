# Local agent-image eval runner

`runner.py` boots a candidate image locally and records repeated task results
from the same `/invocations` endpoint AgentCore uses in production. It records
outcomes and telemetry (#1422), injects a hermetic broker for L1 tasks, and
applies deterministic request/output/trajectory graders (#1424).

## Run the core suite

From the repository root:

```bash
python3 infra/agent-image/eval/runner.py \
  --image <tag-or-digest> \
  --suite infra/agent-image/eval/suites/core.yaml \
  --trials 3 \
  --out /tmp/issue-1424-core.jsonl
```

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
- one JSONL record containing the raw result and complete final-event metadata.

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
needs. Finalization drains already-active broker requests and rejects new work
before acknowledging the boundary. The wrapper's end transition leaves the
stub closed through runner capture collection; installing the next trial uses
a separate root-only token to reopen it, so delayed work cannot spill across
trials. L0 and L2 tasks retain the image's real proxy; pure live and stubbed
tasks use separate containers.

## Task and suite files

Phase-0 task files use a flat, dependency-free YAML subset. Double-quoted
scalars and inline lists/maps use JSON-compatible syntax. Single-quoted scalars
use YAML escaping, so an apostrophe is written twice (`'Don''t use tools'`).
Trailing inline comments are not part of this subset; use their own `#` line.

```yaml
id: arithmetic-no-tools
skill: runner-core
level: L0
workspace: pure
prompt: "Without using tools, calculate 17 times 19."
trials: 3
```

A suite contains relative task paths:

```yaml
tasks:
  - tasks/session-seed.yaml
  - tasks/session-recall.yaml
```

The committed `core.yaml` suite has three L0 tasks. Its seed/recall pair checks
that a passphrase stated under one session is unknown under the next.

## L1 fixtures and graders

An L1 task names one or more relative JSON fixture files and at least one
grader. Graders use inline JSON objects so the runner's dependency-free YAML
subset stays unambiguous:

```yaml
id: directory-lookup
skill: psd-directory
level: L1
workspace: pure
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

`request_body` is an optional partial-object selector. A request to an
allowlisted route without a matching fixture returns a named
`EvalFixtureMissing` response and automatically fails the trial; it never
falls through to a live service or a silent empty response.
Broker operations mirror production: fixtures and requests must use `POST`,
and request bodies must be JSON objects. Fixture files plus the
`broker_request` and `no_route_called` graders require `level: L1`; live L0/L2
tasks reject them instead of grading an empty capture.

Available graders:

- `broker_request` matches route/method and optional body fields. Body matchers
  are `exact`, `contains_any`, and `numeric_equals`; dot paths address nested
  fields.
- `no_route_called` asserts the selected route/method received no request.
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
UV_CACHE_DIR=/tmp/issue-1424-uv-cache \
  uv run --python 3.12 --no-project -m unittest \
  infra/agent-image/test_broker_stub.py \
  infra/agent-image/test_graders.py \
  infra/agent-image/test_eval_runner.py
```

The tests make no AWS, model, Docker, or external-network calls. Broker HTTP
tests bind only an ephemeral loopback port.
