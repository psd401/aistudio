# GLM-5 skill-contract follow-up — 2026-07-30

Issue [#1483](https://github.com/psd401/aistudio/issues/1483) followed up on
the stable-skill regressions observed in the first GLM-5 comparison. This
record captures the reproductions, prompt changes, repeated trials, and
candidate decision. Building and evaluating these images did not deploy or
promote GLM-5.

## Scope and method

- Candidate: Z.AI GLM-5 through native Bedrock Converse and SigV4
- Original comparison digest:
  `sha256:48bdedab676e00d95d107e2f2dc86f159a1ab3123234f3ccb3d8ff224928711c`
- Five original regression tasks, three isolated trials per task
- The focused suite references the existing regression task YAML files.
  Their task definitions and deterministic graders are unchanged.
- Raw JSONL transcripts remain outside the repository. The final committed
  summary contains only aggregate grades and telemetry.

The original immutable image predates the required
`usage_capture_complete` metadata field. A local runner compatibility shim
ignored only that missing legacy field so the original image could be
replayed; it did not change task definitions or graders. The fresh replay
reproduced two still-active contract failures:

| Task | Original comparison | Fresh replay |
| --- | ---: | ---: |
| `data-list-tables` | 1/3 | 2/3 |
| `directory-literal-address-no-lookup` | 2/3 | 3/3 |
| `failure-report-synthetic-missing-data` | 2/3 | 3/3 |
| `freshservice-update-ticket-priority` | 1/3 | 3/3 |
| `workspace-list-unread-mail` | 1/3 | 2/3 |

The replay observed `detailed=false` for the data call and `--json` instead
of `--params` for the workspace query. The first comparison remains the
evidence for the intermittent directory, failure-report, and Freshservice
failures.

## Prompt hardening

The skill contracts now make the stable behaviors explicit:

- table discovery uses exactly `tables --detailed`;
- literal user-provided addresses are copied exactly once without lookup;
- failure reports invoke the reporting tool and only claim logging from its
  returned status;
- Freshservice uses the documented numeric priority, one update, and one
  success response;
- workspace URL/path parameters use `--params`, while request bodies use
  `--json`, with the canonical unread-mail call available before the first
  tool invocation;
- successful failure-report responses use the exact `Failure ID:
  <failure_id>` label; and
- the global rules require reading the current skill instructions before the
  first invocation each turn and preserving exact user-provided text. A sole
  current-message literal is returned without extra prose; compound requests
  preserve the literal while answering the remaining parts, and literals from
  earlier messages, attachments, or tool output must still be used.

Tests pin these instructions and prove the focused suite resolves to the same
task objects as the regression suite. No grader was relaxed to obtain a pass.

## Iterations

| Candidate | Source revision | Results by task | Decision |
| --- | --- | --- | --- |
| `sha256:0246a2246483d5d53f029043f426f4221a4eb447071679c31794c9d1a04017d2` | `ecc637068809f03511177f4f65d9d137d79a1145` | 3/3, 3/3, 3/3, 3/3, 1/3 | Reject: workspace trials skipped the current skill contract. |
| `sha256:b93cba50795243b8b03ce1aa1147e8ff2910ffc4dd92977a6d0a6c764e5e6e4d` | `299e115459896bb6ea19c326d70c9e628b4a3d7f` | 3/3, 2/3, 3/3, 2/3, 2/3 | Reject: one literal was substituted and two correct tool calls ended in post-success runtime errors. |
| `sha256:f5d4a93499b76084b203152a1c5a5a78c2f1758ad8a00f64f5c116dff9cd434b` | `7e806d28e44b2a073741308e591bdd508816cb84` | 3/3, 3/3, 3/3, 3/3, 3/3 | Provisional pass; review found the global literal-only response rule was too broad for compound requests and literals from earlier sources. |
| `sha256:e4f4a25cea83b631dba6aae368235a16abec29bac1646de88d2672c62f92f76d` | `3821cf2eb8b6a794f42d73599fd37d8930810b3c` | 3/3, 3/3, 2/3, 3/3, 1/3 | Reject: one response renamed `Failure ID`, and two workspace trials made a speculative `--json` call before reading the skill. |
| `sha256:6a343e3f1dce515d621f69e9b47f76af4fce01e0ed4cbed183a536b74a6debf5` | `9d00a63e414c89df88e4ab7a0704353cf33f6f76` | 3/3, 3/3, 3/3, 3/3, 3/3 | Accept the narrowed, review-corrected five-contract prompt mitigation. |

The final image also includes the settled post-tool-turn recovery from
[#1469](https://github.com/psd401/aistudio/issues/1469). It passed the build
boot probe, the exact `CANDIDATE_OK` canary, and all 15 focused trials:

| Task | Final result |
| --- | ---: |
| `data-list-tables` | 3/3 |
| `directory-literal-address-no-lookup` | 3/3 |
| `failure-report-synthetic-missing-data` | 3/3 |
| `freshservice-update-ticket-priority` | 3/3 |
| `workspace-list-unread-mail` | 3/3 |

[Transcript-free final summary](../../.eval-runs/sha256-6a343e3f1dce515d621f69e9b47f76af4fce01e0ed4cbed183a536b74a6debf5.json)

## Decision

Explicit skill and global prompt contracts can enforce these five stable
behaviors for GLM-5 without weakening their deterministic graders. The
hardening is model-independent and protects the same contracts for every
candidate.

GLM-5 remains **rejected and unpromoted**. This focused follow-up does not
rerun the complete regression and capability comparison, does not establish
a strict capability improvement, and cannot evaluate the cost clause because
the native transcript reported incomplete token-usage capture. A future
promotion attempt must use a fresh immutable image and satisfy all three
full-suite promotion clauses.
