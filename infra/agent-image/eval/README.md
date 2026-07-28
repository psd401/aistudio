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
short-lived invocation authority. The active chain is re-resolved before every
trial. If temporary credentials rotate, a shared pure-task container is
recycled with the new values; credentials that cannot outlive the configured
invocation timeout fail closed before the trial starts.

JSONL output is created with owner-only (`0600`) permissions because complete
metadata can contain prompts, messages, and tool details. Keep it in an
issue-specific temporary path; do not commit run transcripts.

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
