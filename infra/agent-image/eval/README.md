# Local agent-image eval runner

`runner.py` boots a candidate image locally and records repeated task results
from the same `/invocations` endpoint AgentCore uses in production. Phase 0
(#1422) records outcomes and telemetry; deterministic graders are added by
#1424.

## Run the core suite

From the repository root:

```bash
python3 infra/agent-image/eval/runner.py \
  --image <tag-or-digest> \
  --suite infra/agent-image/eval/suites/core.yaml \
  --trials 3 \
  --out /tmp/issue-1422-core.jsonl
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
starts.
When a post-mint credential check recycles the runtime, the runner discards
that authority and remints it for the ready container before invoking.

JSONL output is created with owner-only (`0600`) permissions because complete
metadata can contain prompts, messages, and tool details. Keep it in an
issue-specific temporary path; do not commit run transcripts.

Resolved short-lived AWS credentials are passed into the candidate container's
environment and are therefore visible to users with access to the local Docker
daemon (for example through `docker inspect`). Run evals only on a trusted
workstation. The runner removes its containers on completion and logs a warning
if Docker cannot remove one.

Every trial gets:

- a fresh UUID in `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`;
- a signed context minted for that exact UUID immediately before invocation;
- one JSONL record containing the raw result and complete final-event metadata.

`workspace: pure` tasks share one container while retaining conversational
isolation through fresh session IDs. `workspace: mutating` tasks boot a fresh
container for every trial so local files and memory cannot leak.

## Task and suite files

Phase-0 task files use a flat, dependency-free YAML subset:

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

## Hermetic tests

```bash
UV_CACHE_DIR=/tmp/issue-1422-uv-cache \
  uv run --python 3.12 --no-project -m unittest \
  infra/agent-image/test_eval_runner.py
```

The tests use fake runtimes only: they make no network, AWS, model, or Docker
calls.
