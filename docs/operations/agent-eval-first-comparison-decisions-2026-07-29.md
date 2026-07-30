# Agent eval first comparison decisions — 2026-07-29

Issue [#1429](https://github.com/psd401/aistudio/issues/1429) ran the
first image-level harness, prompt, and model comparisons from epic
[#1421](https://github.com/psd401/aistudio/issues/1421). This record captures
the human promote/reject decisions that sit beside the generated reports.
Building an image or recording a decision did not change the deployed
AgentCore runtime.

## Run contract

- AI Studio image source:
  `68da9634b585515303031e14bf9f78f4db9808ca`
- Final evaluator, suite, and grader revision:
  `fef7087027969418762deff6901d8b29566c6927`
- 50 tasks per arm: 32 regression and 18 capability
- 3 trials per task; pass^3 requires all three to pass
- Same ARM64 host and synthetic owner for every arm
- Summaries contain only aggregate grades and telemetry. Raw JSONL trial
  records were kept outside the repository.

Every candidate manifest varies exactly one complete axis from
`eval/candidates/manifests/baseline.json`.

## Decisions

| Arm | Immutable digest | Observed cache | Promotion clauses | Decision |
| --- | --- | --- | --- | --- |
| OpenClaw `2026.7.2-beta.5` harness | `sha256:6aaa879b034bed2b44af8d25aa4a681a65c1f896d4632af7c18e2bc14eff5825` | uncached | regression PASS; capability FAIL (17/18 → 17/18); cost DECLINED | **REJECT** |
| Conservative tool-routing prompt | `sha256:018087e485ce00dbba2698072dc9964b6321b2a2890fb63ea9e4dfd208f32762` | cached | regression FAIL; capability FAIL (17/18 → 17/18); cost PASS (+0.68%) | **REJECT** |
| Z.AI GLM-5, native Bedrock | `sha256:48bdedab676e00d95d107e2f2dc86f159a1ab3123234f3ccb3d8ff224928711c` | uncached | regression FAIL; capability FAIL (17/18 → 17/18); cost DECLINED | **REJECT** |
| OpenAI GPT OSS 120B, Mantle | `sha256:89a95ae81fde54daebf8d81f99fb9bed098481a4b6fa25277af3dffd97873333` | cached | regression FAIL; capability FAIL (17/18 → 6/18); cost PASS (-97.35%) | **REJECT** |

The baseline is Claude Sonnet 5 at
`sha256:478ea37b04b53f8669e16d514dc6e079a5a148010cc39e726c6e3d48ef0bea42`
with observed caching `cached`.

### Harness bump

The calibration succeeded in its primary purpose: after bench compatibility
fixes, the beta harness had no regression-suite skill drops. It did not
improve overall capability, however, and observed cache reads disappeared.
Because caching differs, the report deliberately declines the cost clause.
Mean latency increased 1.59 seconds and p95 increased 2.73 seconds.

Decision: reject the beta candidate. It demonstrates that the upgraded host
can preserve skill quality, but does not satisfy the promotion rule and loses
the baseline's observed caching behavior.

[Harness report](../../.eval-runs/comparison-sha256-478ea37b04b53f8669e16d514dc6e079a5a148010cc39e726c6e3d48ef0bea42-vs-sha256-6aaa879b034bed2b44af8d25aa4a681a65c1f896d4632af7c18e2bc14eff5825.md)

### Conservative tool-routing prompt

The prompt stayed within the bootstrap limits: effective `SOUL.md` was 27,974
characters and all bootstrap files totaled 31,149 of 80,000 characters. It
improved `workspace-list-unread-mail` from 2/3 to 3/3, but
`directory-email-exact-match` fell from 3/3 to 2/3 after one
`ChatDeadlineExpiredPartial`. The per-skill floor therefore fails. Capability
was unchanged, cost rose 0.68%, mean latency rose 1.21 seconds, and p95 latency
rose 7.68 seconds.

Decision: reject the prompt. A cross-skill improvement cannot compensate for
a stable-skill regression. Follow-up:
[#1482](https://github.com/psd401/aistudio/issues/1482).

[Prompt report](../../.eval-runs/comparison-sha256-478ea37b04b53f8669e16d514dc6e079a5a148010cc39e726c6e3d48ef0bea42-vs-sha256-018087e485ce00dbba2698072dc9964b6321b2a2890fb63ea9e4dfd208f32762.md)

### GLM-5

GLM-5 regressed `psd-data`, `psd-failure-report`, `psd-directory`, and
`psd-freshservice`. Trial evidence includes wrong broker argument values,
duplicated exact output, a fabricated successful failure report without the
required tool call, and an unstubbed extra request. Workspace unread-mail also
degraded from 2/3 to 1/3. Capability stayed at 17/18.

Observed caching differs from baseline, so the raw lower token cost is shown
but the cost verdict is declined. Mean latency increased 17.70 seconds and p95
increased 42.38 seconds.

Decision: reject GLM-5. Follow-up:
[#1483](https://github.com/psd401/aistudio/issues/1483).

[GLM-5 report](../../.eval-runs/comparison-sha256-478ea37b04b53f8669e16d514dc6e079a5a148010cc39e726c6e3d48ef0bea42-vs-sha256-48bdedab676e00d95d107e2f2dc86f159a1ab3123234f3ccb3d8ff224928711c.md)

### GPT OSS 120B

GPT OSS passed some self-contained generation tasks, but tool-heavy behavior
was not compatible with the current OpenClaw/Mantle path:

- 95 of 150 trials reported `OpenClawChatError`;
- runtime failure rate was 63.33%;
- overall pass^3 was 13/50; and
- capability pass^3 was 6/18.

Observed cache-read telemetry classified both arms as cached even though the
candidate config uses `cacheRetention: none`; the report intentionally follows
observed telemetry. Cost fell 97.35%, but the quality clauses fail
overwhelmingly.

Decision: reject GPT OSS 120B. Follow-up:
[#1484](https://github.com/psd401/aistudio/issues/1484).

[GPT OSS report](../../.eval-runs/comparison-sha256-478ea37b04b53f8669e16d514dc6e079a5a148010cc39e726c6e3d48ef0bea42-vs-sha256-89a95ae81fde54daebf8d81f99fb9bed098481a4b6fa25277af3dffd97873333.md)

## Calibration findings

The harness arm initially appeared broadly red because the bench had not
tracked host and output-contract changes:

- OpenClaw `2026.7.2-beta.5` moves/removes three config keys.
- The beta uses the local `cli`/`cli` gateway identity rather than the
  production TUI identity.
- `websocket-client` adds an Origin header unless explicitly suppressed;
  newer OpenClaw versions classify an Origin-bearing connection as browser
  traffic and do not grant the intended local CLI scopes.
- Deterministic graders must accept stable semantic variants such as a
  documented identifier rendered as text or JSON, equivalent decision verbs,
  split label/value facts, Unicode typography, and reordered required terms.

The candidate manifest now records version-specific migrations and identity,
the backend socket suppresses its synthetic browser Origin, and focused tests
lock each accepted output contract. The calibration tasks were rerun for every
arm under the final evaluator before summaries were generated.

See
[the calibration learning](../learnings/testing/2026-07-29-calibration-runs-separate-bench-failures-from-agent-regressions.md)
for the reusable testing guidance.
