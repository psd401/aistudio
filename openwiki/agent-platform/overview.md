---
type: Platform Overview
title: Agent Platform & Skills System
description: Extensible agent skill system with 39 domain-specific capabilities including media processing (HTML-to-PDF, ffmpeg, transcription), Google Workspace integration, Cedar governance, and MCP tool exposure for K-12 AI assistants.
tags: [agents, skills, mcp, workspace, governance]
---

# Agent Platform

AI Studio includes an agent platform that enables autonomous AI assistants to perform real work through a growing library of skills. The platform prioritizes security, auditability, and K-12-specific workflows.

## Agent Skills System

**Location**: `/infra/agent-image/skills/`

Agent skills are modular capabilities packaged in standardized directories. Each skill follows the same structure:

```
infra/agent-image/skills/{skill-name}/
├── SKILL.md              # Skill definition and usage
├── run.js                # Primary execution logic
├── run.test.js           # Tests
├── package.json          # Dependencies
└── references/           # Supporting documentation
```

### Skill Categories

**Administrative & District Operations**
- `psd-atrium` — Read/search/create content in Atrium; artifact data persistence (list-data, submit); viewer-scoped PSD data queries from artifacts via shared connector resolution with Nexus
- `psd-freshservice` — Freshservice tickets, service catalog items, approvals, and team summaries using each caller's own API key; create catalog request forms with field validation
- `psd-email-triage` — Automated email response drafting
- `psd-schedules` — Scheduled agent tasks (cron/rate/at) with read access for scheduled-mode turns; reply IS the delivery — never hunt for DM
- `psd-rules` — Tier-1 governance rules for agent behavior
- `psd-conversation-coach` — Crucial Conversations framework coaching for difficult conversations
- `psd-morning-brief` — Personalized daily newspaper/podcast delivered through private Atrium artifacts
- `psd-observances` — Cited dates for national observances, awareness months, state school holidays, and education conferences via NSPRA calendar lookups
- `psd-directory` — Identity lookup for staff and colleagues by email or Google Chat sender ID

**Content & Media**
- `psd-aistudio` — Live capability discovery + authenticated actions in AI Studio
- `psd-learning-page` — Multimodal UDL learning page generation
- `psd-hyperframes` — HTML/CSS/JS to MP4 video rendering
- `psd-html-artifact` — HTML artifacts published to Atrium with WCAG 2.2 AA audit, delivered as internal reader pages (not S3)
- `psd-print-pdf` — HTML to printable PDF with headless Chromium (8.5×11, letter, A4, landscape), honouring `@page` CSS, flexbox, and web fonts; routes through agent-media Lambda
- `psd-media` — ffprobe inspection + ffmpeg transcode via named presets (`social-mp4`, `web-mp4`, `audio-mp3`); routes through agent-media Lambda
- `psd-transcribe` — Speech-to-text using Amazon Transcribe over audio/video in owner's private workspace; routes through agent-media Lambda
- `psd-pdf-to-markdown` — PDF to Markdown conversion; scanned/image-only PDFs rendered to page images via `--rasterize-pages`
- `psd-image-gen` — Image generation
- `psd-sop-creator` — PSD Standard Operating Procedure document creation
- `psd-instructional-vision` — PSD instructional framework (Instructional Essentials, UDL, MTSS) from live repository
- `psd-publish-file` — Publish generated local files (PDF, PNG, CSV, MP3, MP4) to public-by-link S3 URLs

**Data & Integration**
- `psd-data` — District data queries (PowerSchool, spreadsheets)
- `psd-workspace` — Google Workspace wrapper for agent accounts
- `psd-credentials` — Secure credential management and capability verification
- `psd-canva` — Canva design integration
- `psd-plaud` — Plaud note integration
- `psd-open-adaptive-district` — Open Adaptive District operating model (six-week build cycle)

**Analysis & Reporting**
- `psd-deep-research` — Gemini Deep Research for cited multi-source reports
- `psd-workflows` — Dynamic PSD gateway workflows (evaluations, requests, timesheets) with caller binding
- `quartile-growth-report` — Growth-by-quartile spreadsheet generator for elementary school principals (one tab per grade, data-only output)
- `psd-failure-report` — Failure analysis and reporting
- `psd-last30days` — Recent activity analysis
- `psd-github` — GitHub integration
- `psd-summarize` — Content summarization
- `psd-tts` — Text-to-speech
- `psd-strategic-plan` — Peninsula 2030 strategic plan queries from live repository 166

**Utilities**
- `chat-card`, `chat-chart` — Chat UI enhancements
- `psd-brand-guidelines` — PSD branding enforcement
- `psd-skills-meta` — Skill metadata and discovery

### Skill Execution

Skills run in the agent container defined by `/infra/agent-image/Dockerfile`. The harness:
1. Loads skill from `/opt/psd-skills/{skill-name}/`
2. Validates governance policies via Cedar
3. Executes skill logic with requested capabilities
4. Audits all credential reads and tool invocations

### Media Relay Transport

**Source**: `/infra/agent-image/skills/_shared/media-relay.js`, `/infra/agent-image/mantle_proxy.py`

The `psd-print-pdf`, `psd-media`, and `psd-transcribe` skills route through a shared transport that:

- Uploads workspace objects to `.media-scratch/` via the workspace broker (added to checkpoint exclusions in workspace-policy.json)
- Invokes the agent-media Lambda through the root-owned loopback relay
- Validates workspace-relative paths against traversal, backslashes, and control characters
- Removes scratch objects on all exit paths (important for transcription: the transport copy is someone's voice)

The relay injects `workspacePrefix` from the web-verified invocation context — the caller never states who it is, preventing cross-owner access. Publishing stays separate through `psd-publish-file` and its sensitivity gate.

### Bundled Skill Manifest

Agent image builds include a bundled skill catalog (`/infra/lib/bundled-skill-manifest.ts`) that enforces catalog approval for skill loads. The manifest:

- Parses SKILL.md frontmatter (name, summary, allowed-tools)
- Validates against image tag and source hash
- Registers skills via CloudFormation custom resource (`agent-skill-initializer` Lambda)
- Enforces catalog approval before execution

The skill initializer (`infra/lambdas/agent-skill-initializer/`) handles both registration and retirement of bundled skills, ensuring only approved capabilities execute in the agent container.

---

## OpenClaw Tool Policy

**Sources**: `/infra/agent-image/openclaw.json`, `/infra/agent-image/test_openclaw_tool_policy.py`, `/infra/agent-image/harness_adapter.py`

The OpenClaw gateway configuration enforces tool denial policies that prevent runtime failures from poisoning the agent's context. The most critical denial is `ask_user`.

### `ask_user` Tool Denial

**Configuration**: `openclaw.json` → `tools.deny`

The `ask_user` tool is **permanently denied** in the OpenClaw configuration. This is not a preference—it is a structural requirement of the AgentCore runtime:

1. **Gateway Lifecycle**: AgentCore provides one container per invocation. The harness stops the OpenClaw gateway ~3ms after the final event and starts a fresh one for the next message.
2. **Question Lifetime**: `ask_user` registers a question on the gateway and waits for `question.resolve`. When the gateway stops, the question dies.
3. **Resolution Failure**: On the next turn, the resolve attempt fails with `question '<id>' was not found`. Production logs from 2026-08-31 to 2026-09-05 show 19 attempts, 19 failures, zero successes.
4. **Context Poisoning**: The orphaned `toolCall` receives a synthetic `isError: true` result reading:
   ```
   [openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.
   ```

The model interprets this error as the user interrupting it. In a real session, the agent responded "Got it — pausing since you interrupted that run" four turns after asking a question, even though the user had never stopped anything.

### Synthetic Repair Marker

**Source**: `/infra/agent-image/skills/psd-rules/SKILL.md`

The `psd-rules` skill contains a rule that names the synthetic repair marker verbatim. This teaches the model that the marker is **bookkeeping about a tool**, never a statement about the user.

The rule instructs the agent to read the marker as "that one tool produced nothing — redo it or work around it" and to never turn it into a claim that the user stopped, interrupted, or aborted anything.

### Contract Validation

**Source**: `/infra/agent-image/test_openclaw_tool_policy.py`

The `test_openclaw_tool_policy.py` test suite validates:

- `ask_user` is in the `tools.deny` list
- The denial name matches the normalized tool name (`ask_user`, not `askUser` or `ask-user`)
- The existing denials (`cron`, `nodes`, `gateway`, `sessions`, `agents`) survive
- `psd-rules/SKILL.md` quotes the synthetic repair marker verbatim

**Test Command**:
```bash
cd infra/agent-image && python -m pytest test_openclaw_tool_policy.py -v
```

### Historical Context

The `_resolve_pending_question()` function in `harness_adapter.py` is **kept but unreachable**. The function was written to resolve questions on subsequent turns, but the gateway restart invalidates the question before resolution is possible. Its docstring now records that it has never succeeded and why, so future readers do not re-derive the same broken solution.

A `question.resolve` line in the logs is now a signal that something re-introduced a question-asking tool.

### Update Channel Configuration

**Source**: `/infra/agent-image/openclaw.json` — `update.channel`

The `update.channel` setting pins plugin resolution to the host version, preventing upstream npm dist-tag moves from breaking agent cold starts.

**Problem (2026-09-10 Production Incident)**:

OpenClaw's startup doctor treats plugins named in `plugins.entries` as "missing configured plugins" and npm-installs them on every container cold start into `~/.openclaw/npm/projects/`. This install is dead weight—the loader immediately discards it and uses the vendored copies—but the install's *failure* is fatal.

Without an explicit update channel, the running beta core version (2026.7.2-beta.5) forced the `beta` channel via `resolveRegistryUpdateChannel()`, which rewrote bare specs to `<name>@beta`. On 2026-09-08, both `@beta` dist-tags moved to version 2026.9.3, which declares `compat.pluginApi >=2026.9.3`. The digest-pinned base image exposes plugin API 2026.7.2-beta.5.

The doctor refused to report the gateway ready. AgentCore returned 424 to every request. 1,849 of 1,926 prod cold starts failed (96%) with no code deploy—the running image was unchanged.

**Fix**:

`update.channel: "extended-stable"` takes an alternate branch in `resolveNpmInstallSpecsForUpdateChannel()`. For trusted official plugins (both `amazon-bedrock` and `parallel` are in the official catalog), it resolves `<name>@<coreVersion>` — the exact host version.

This matches the vendored copies in `/opt/openclaw-plugins/`, so the doctor's throwaway install always succeeds. Future upstream tag moves cannot reach the agent.

**Resolution comparison**:

| Channel | Resolution | Outcome |
|---------|------------|---------|
| (unset, beta core) | `<name>@beta` | Broke when @beta moved to 2026.9.3 |
| `stable` / `dev` | `<name>@latest` | Also 2026.9.3 — would still break |
| `extended-stable` | `<name>@2026.7.2-beta.5` | Matches vendored copies, always works |

**Security note**: `update.auto` remains disabled (`update.auto.enabled` is false when unset). This setting affects plugin resolution only, not core self-updates.

**Test**: The `check_config_consistency.py` validation passes with this configuration.

---

## Fused Chat Final Recovery

**Source**: `/infra/agent-image/harness_adapter.py` — `_prefer_terminal_segment()`

The live OpenClaw gateway fuses a turn's assistant text blocks into a single `final` payload. This section documents how the harness prevents that fusion from shipping narration to the user.

### Gateway Fusion Behavior

The chat channel's `final` payload carries **every assistant text block the turn produced**, concatenated into one string with **no separator**. A turn with six assistant messages (five ending with `stopReason=toolUse`) arrives as a single fused message.

**Production Evidence**: Run `a33a3f92` on 2026-09-06 produced a 54-tool-call turn with six assistant messages. The final payload was 1630 chars—the exact sum of all six blocks—reading:

> "...fix that written file.Let me just avoid the script entirely and use jq.Bad literal newline. Let me repair it.None of the 18 items match…"

The boundary-aware accumulator had already isolated the terminal segment, but the `final` payload overwrote it, delivering the fused scratchpad to the user.

### Terminal Segment Preference

The `_prefer_terminal_segment()` static method undoes the fusion when the signature is unambiguous:

**Trigger conditions (ALL required)**:
- Chat text is non-empty
- Accumulator is non-empty
- Chat text ≠ accumulator
- Chat text **ends with** the accumulator (strict suffix)

When these conditions match, the method returns the accumulator (terminal segment) instead of the fused chat text. Otherwise, the gateway's final wins—even when richer than the accumulator.

**Why narrow**: The method fires ONLY on the fusion signature. A clean final, an equal string, or text that merely contains the segment elsewhere is returned untouched.

### Historical Context

**Problem Measurement**: Across this workspace's history, **56% of turns ship more than one text block**. On those turns, a median **51% of what the user reads is narration**. In the worst case, it was 98%.

This was invisible to `ReplyIsTheAnswerOnly` tests for two years because `FakeGateway`'s final carries no message text—the test never reached the problematic assignment. The production gateway does carry text, and it overwrote the accumulator.

**Recommended Agent Behavior**: Write **no text until writing the answer**. Think in reasoning, act with tools, and stay silent between them. The first character of visible text should be the first character of the finished reply. This follows `psd-rules` Rule 1 guidance.

### Test Validation

**Source**: `/infra/agent-image/test_reply_replay.py`

The `FusedChatFinalDoesNotOverrideTheTerminalSegment` test suite validates:

- Only the terminal segment is delivered (not narration)
- No narration blocks survive in the reply
- The fusion signature is eliminated
- Clean finals still win (gateway authoritative when not fused)
- A final matching the accumulator is unchanged

The `TerminalSegmentPreferenceIsNarrow` test suite validates the method's narrow trigger:

- Strict superset ending in segment → trimmed
- Equal string → untouched
- Segment appearing mid-string → untouched
- Empty accumulator → chat text wins
- Empty chat text → returned as-is

**Test Command**:
```bash
cd infra/agent-image && python -m pytest test_reply_replay.py::FusedChatFinalDoesNotOverrideTheTerminalSegment -v
cd infra/agent-image && python -m pytest test_reply_replay.py::TerminalSegmentPreferenceIsNarrow -v
```

---

## Workspace Checkpoint Recovery

Agent workspaces use journal-based finalization proofs to survive invocation failures and resume idempotently.

### Workspace Size Limits & Pruning

**Source**: `/lib/agent-workspace/storage-broker.ts`, `/infra/agent-image/workspace_sync.py`

The maximum workspace upload size is **512 MiB** (raised from 256 MiB on 2026-09-05). This is an application constant, not an S3 limit (single PUT accepts 5 GB). The prior ceiling became a hard outage when OpenClaw's transcript database (`openclaw-agent.sqlite`) grew monotonically without pruning, blocking all saves for affected owners.

**Prune Mechanics**: `prepare_sqlite_snapshot()` now prunes closed-session `trajectory_runtime_events` rows for any `openclaw-agent.sqlite` over 192 MiB:
- Deletes rows for sessions with no activity in the last 2 days
- VACUUMs after delete (driven by `freelist_count`, not just delete success)
- Preserves `transcript_events`, `session_windows`, `memory_index_chunks`, and `memory_embedding_cache`
- Schema-resilient: column names discovered via `table_info`, unknown schema prunes nothing
- Deadline enforced via progress handler with single budget spanning snapshot + push

Both the size increase and the prune are required—the prune cannot run until the workspace can be written again.

**Deploy Order**: The web tier (`storage-broker.ts`) must deploy before the agent image (`workspace_sync.py`). The agent's client-side cap check (`BROKER_PRIVATE_UPLOAD_MAX_BYTES`) must match the broker's `MAX_PRIVATE_UPLOAD_BYTES` or the pre-check passes a file the broker refuses.

### Reservation Release on Abort

**Source**: `/lib/agent-workspace/storage-broker.ts` — `releaseWorkspaceUploads()`

When one file in a batch is refused, siblings' reservation rows stay `reserved` for the 5-minute lease. The unique index `uq_workspace_upload_target_active` then rejects the retry's reservation for those paths. The `releaseWorkspaceUploads()` function lets the agent return the batch on abort, removing the dead window.

- Owner-scoped and `reserved`-only: never touches another owner's rows, committed uploads, or `verifying` entries
- Idempotent: unknown or already-settled IDs are silently skipped
- Best-effort lease return: dropLease failures do not fail the abort

### Journal-Based Finalization

When workspace changes are committed, a finalization proof is stored in the journal table with:

- Owner hash and workspace prefix
- Base generation and proof hash
- Reservation IDs and deleted paths
- Invocation nonce and expiry

If a final flush fails or times out, the harness retries the fenced batch at the start of the next invocation. The stored proof carries the original invocation's nonce and expiry.

### Journaled Replay

**Source**: `/lib/agent-workspace/storage-broker.ts`

The `journaledReplay` option in `verifyWorkspaceFinalizationProof()` relaxes ONLY the invocation binding—never the signature, workspace prefix, or generation. A byte-identical journal entry proves the request was already admitted under valid invocation, allowing the retry to succeed.

**Why it's safe**: The caller only passes `journaledReplay` when a journal entry on the same prefix matches the request byte for byte. Cross-generation and cross-owner replay remain blocked by the retained generation claim and manifest-generation check.

### Stale Proof Recovery

**Source**: `/infra/agent-image/workspace_sync.py`

When a warm microVM serves a second invocation without re-running `refresh_workspace`, it may finalize with the previous invocation's cached proof. The broker binds proofs to a specific invocation's nonce and expiry, so it refuses stale proofs with a 409.

**Historical context (prod 2026-09-11)**: A warm microVM finalized with a stale proof, the broker refused with a bare 409, and the push died leaving reservations `reserved`. The retry four minutes later collided with its own rows on `uq_workspace_upload_target_active` and surfaced as an opaque 502.

#### Re-Proof Flow

**Source**: `/infra/agent-image/workspace_sync.py` — `_is_completion_conflict_rejection()`, `_reproof_pending_atomic_finalization()`

When `finalize-checkpoint` returns 409:

1. **Detect conflict**: `_is_completion_conflict_rejection()` identifies finalize 409 (vs other errors)
2. **Re-mint proof**: `_reproof_pending_atomic_finalization()` calls `_ensure_workspace_checkpoint()` to get fresh proof
3. **Validate generation unchanged**: If workspace generation moved, the 409 was a real conflict—release reservations and raise
4. **One retry allowed**: Re-attempt finalize with fresh proof; second refusal keeps batch for resume path
5. **Ambiguous failures (502)**: Do NOT release reservations—broker may have partially committed, and claims reset to `reserved` precisely so replay can complete

**Why re-proof is bounded**: `ensure-checkpoint` is the same call `refresh_workspace` uses, so this adds no authority the invocation did not already hold. The broker still verifies the fresh proof in full.

#### Cleanup Budget Independence

**Source**: `/infra/agent-image/workspace_sync.py` — `CLEANUP_BUDGET_SECONDS`, `_cleanup_deadline()`

Cleanup (`_release_staged_reservations`) gets its own budget independent of the turn deadline. The 2026-09-11 timeout spent its turn deadline getting reservations, so `_remaining_timeout` raised before the release could be attempted. `CLEANUP_BUDGET_SECONDS = 15` is enough for the bounded release loop while staying inside Lambda wall time.

#### Test Validation

**Source**: `/infra/agent-image/test_workspace_sync.py` — `StaleFinalizationProofRecoveryTests`

The test suite covers:

- Stale proof is re-minted and push completes (verifies fresh proof used on retry)
- Generation-moved conflict releases reservations (can never replay)
- Ambiguous 502 keeps rows for resume path (no release, batch retained)
- Second refusal after re-proof keeps rows (re-proofed attempt crossed ambiguity boundary)
- Cleanup does not inherit exhausted turn deadline

**Test Command**:
```bash
cd infra/agent-image && python -m pytest test_workspace_sync.py::StaleFinalizationProofRecoveryTests -v
```

### Checkpoint Retry Recovery

**Source**: `/infra/agent-image/agentcore_wrapper.py`

When a pending checkpoint cannot be replayed, the local changes are quarantined (generation invalidated) and the turn continues with a full restore from the committed manifest. This records at `warn` severity with `recovered: true` and does not trigger alerts—the failure that matters is a restore that cannot be completed, which still raises.

### Session Lock Retention Diagnostics

**Source**: `/infra/lambdas/agent-router/index.ts` — `invokeWithSessionLockLease()`

When AgentCore completion is unconfirmed and a workspace lock is retained, the warning now includes `ownerEmail` and `spaceName` in addition to `sessionId`. A retained lock blocks all turns for that owner until the TTL expires (30 minutes), so identifying the affected user from logs requires owner attribution—`sessionId` alone is a hash that cannot be reversed.

Historical context: six retained-lock events belonged to one user, but correlating requestIds back to spaces required a manual research project. The diagnostic fields make this a log search.

### Front-Door Rejection and Mutex Release

**Source**: `/infra/lambdas/agent-router/index.ts` — `FRONT_DOOR_REJECTION_STATUSES`, `agentCoreHttpFailure()`

Not all HTTP failures indicate a potential in-flight write. The `FRONT_DOOR_REJECTION_STATUSES` constant defines status codes that prove AgentCore rejected the call at its front door, before any microVM was started:

| Status | Meaning | Why Safe to Release |
|--------|---------|---------------------|
| **429** | Throttle refused before scheduling | No container was allocated |
| **502** | Edge failure (nginx error page) | Call never reached AgentCore runtime — body is nginx HTML, not an AgentCore response |
| **503** | Service unavailable at front door | Request refused before scheduling |

When one of these statuses occurs, `agentCoreHttpFailure()` sets `workspaceFinalizationConfirmed: true`, signaling to `invokeWithSessionLockLease()` that the mutex can be released immediately. The same contract already applied to `AgentNotDeployed` (local rejection before any runtime call).

**Deliberately absent from the set:**

- **504** — The gateway can return this while a microVM is still working. Turns of 80–200 seconds are normal, so a gateway timeout is precisely the "may still be finalizing" case the lock retention exists to protect.
- **424** — By the time readiness fails ("An error occurred when starting the runtime"), the wrapper has already booted and restored the workspace. Runtime logs show `BUILD_MARKER`, the Mantle proxy, and workspace restore all completing before the readiness check fails. A container that reached that point may have written to the workspace.
- **500** — An opaque server error proves nothing about the runtime state.

#### Historical Context (2026-09-10 Incident)

An edge 502 (nginx failure in ~1.2s) retained the workspace lock for its full 30-minute TTL. Every subsequent turn for that owner deferred on `workspace-contended` until the TTL lapsed. Two users' threads were silently frozen for 30 minutes each, with no signal beyond one generic error.

The fix ensures that status codes proving "no microVM ever started" immediately release the lease, while statuses where a container may still be finalizing conservatively retain it.

#### Test Coverage

**Source**: `/infra/lambdas/agent-router/index.test.ts` — `describe("front-door rejections and the owner workspace mutex")`

- 429, 502, 503 release the workspace lock (`workspaceFinalizationConfirmed: true`)
- 504, 424, 500 retain the workspace lock (`workspaceFinalizationConfirmed: false`)
- Throttle (503) and edge failure (502) have distinct error classes
- Edge 502 actually frees the lease via `releaseSessionLock`
- Gateway timeout (504) retains the lease to avoid racing a finalizing microVM

**Test Command**:
```bash
cd infra/lambdas/agent-router && bun test --test-name-pattern="front-door rejections"
```

### Cutover Guard (Build-Time Contract Validation)

**Sources**:
- `/infra/agent-image/workspace_contract.py` — Contract fingerprint extraction
- `/infra/agent-image/build-and-push.sh` — CI integration
- `/infra/agent-image/test_workspace_contract.py` — Tests

When deploying a new agent image, a rolling update briefly runs old and new writers simultaneously. This is only dangerous when the two disagree about something **persisted**: the proof string format, the checkpoint manifest or journal shape, the object-key layout, or the generation schema.

The cutover guard fingerprints these contract elements and compares them across the deployed and candidate commits. A change triggers the full cutover procedure (pause ingress, drain writers, ordered redeploy, post-drain inventory audit).

#### What Is Fingerprinted

From `storage-broker.ts`:
- `WORKSPACE_FINALIZATION_PROOF_VERSION`
- `WORKSPACE_CHECKPOINT_VERSION`
- `WORKSPACE_CHECKPOINT_CONTROL_PREFIX`
- `WORKSPACE_CHECKPOINT_GENERATION_RE`
- `PUBLIC_CONTENT_TYPES` (content-type map)
- Type definitions: `WorkspaceCheckpointManifest`, `WorkspaceFinalizationJournal`, `WorkspaceFinalizationProofClaims`

From `workspace_sync.py`:
- `WORKSPACE_UPLOAD_CONTENT_TYPE`
- `_SKIP_RELATIVE_PREFIXES`

From migration 171:
- Whole-file hash of the generation/journal schema

#### What Is NOT Fingerprinted

Comments, log lines, validation logic, and non-contract constants do not move the fingerprint. A version bump, renamed control prefix, changed manifest field, or schema edit all do.

#### Fail-Closed Behavior

If extraction finds no anchors in a file that exists, it raises `ContractExtractionError` and the build treats this as cutover-required. A refactor that renames every constant must not quietly yield an empty fingerprint that compares equal to everything forever.

#### CI Integration

The guard runs during `build-and-push.sh`:
- **Exit 0**: Contract unchanged — no cutover required
- **Exit 1**: Contract changed — full cutover procedure required
- **Exit 2**: Extraction failed — fail closed, treat as cutover required

---

## Failure Telemetry Hygiene

The agent platform carefully tracks failures while avoiding false positives from recovered turns.

### Deferred Failure Recording

**Source**: `/infra/agent-image/harness_adapter.py`

When `process()` may still recover a turn by retrying, the failure is held in `TurnResult.deferred_failure` rather than written immediately. The retry path:

- **Success**: Drops the deferred row—the turn recovered, so no `agent_failures` row is written
- **Failure**: Flushes both attempts' rows—the turn really did fail twice

This prevents recovered turns from inflating failure metrics. In the week of 2026-08-21, 8 of 10 `OpenClawChatError` rows had already been recovered by retry but were still written as errors, making 10 broken turns appear when only 2 actually failed.

### Promoted Turn Acknowledgement

**Source**: `/infra/lambdas/agent-router/index.ts`, `/infra/lambdas/agent-cron/run-telemetry.ts`

When an interactive turn times out or overflows but is promoted to a job queue, `markPromotedTurnRecovered()` downgrades the failure row:

- Severity set to `warn`
- Acknowledged with `system:job-promotion`
- Context marked with `promoted: true`

This preserves latency and overflow trending data while ensuring the Failures tab shows what actually broke. In the week of 2026-08-21, 14 of 35 hard-error rows described turns the user got answered via job promotion.

### Schedule Contention Settlement

**Source**: `/infra/lambdas/agent-cron/run-telemetry.ts`

Every schedule an owner has shares ONE workspace lock, so same-cadence schedules contend by design. When a fire finds the lock held, it records a `warn` row and retries. `settleCronFireFailure()` acknowledges that row once the fire succeeds, preventing contention warnings from burying real failures.

- **Best-effort**: A settle failure never turns a successful run into a reported failure
- **Re-opens on late failure**: If the same `fire_key` fails after the retry succeeded, the upsert clears `acknowledged` so the real failure surfaces
- **No time window needed**: `fire_key` is a unique Scheduler occurrence identity, not a reused session ID

### Owner Workspace Contention Wait

**Source**: `/infra/lambdas/agent-cron/index.ts` — `isOwnerWorkspaceContention()`, `runLockedScheduleTurnAwaitingOwner()`

EventBridge Scheduler spends its 5 retries in ~3 minutes (observed: +59s, +115s, then nothing). An agent turn runs 4–15 minutes. A fire that loses the owner workspace lock therefore burned its whole budget before the holder could possibly finish, and was dropped to the DLQ—247 dead fires by 2026-09-12, plus the superintendent's Weekly Brief on 2026-09-11 which vanished with no error to the user.

#### Wait Mechanism

Instead of racing the lock and failing, the invocation now polls until the holder releases or the budget exhausts:

- **Wait budget**: `OWNER_CONTENTION_WAIT_BUDGET_MS = 5` minutes
- **Poll interval**: `OWNER_CONTENTION_POLL_MS = 15` seconds
- **Reserve for turn**: `OWNER_CONTENTION_REMAINING_RESERVE_MS = 10` minutes (leaves enough Lambda wall time for the turn + reply + workspace flush)

If the budget or Lambda remaining time runs out, the fire falls through to exactly the previous behavior (DLQ). The wait can only convert drops into runs.

#### When to Wait

`isOwnerWorkspaceContention()` returns `true` only when ALL conditions hold:

| Condition | Why |
|-----------|-----|
| Phase is `lock-contention` | Config/renewal faults cannot be waited out |
| Holder is identified (`ownerFireKey: string`) | Unidentified holder might be this fire meeting its own lock |
| Holder key ≠ fire's own key | Same key is duplicate delivery, must coalesce immediately |
| `resolveScheduleLockContention()` returns `retry` action | `coalesce` action means earlier fire of same schedule—must not delay |

#### What NOT to Wait For

- **Same fire key on both sides**: One fire meeting its own lock is a duplicate delivery. Waiting would run the same occurrence twice.
- **Same schedule, earlier fire**: High-frequency schedules catching their predecessor must coalesce immediately.
- **Config faults (`lock-config`)**: No amount of waiting fixes a missing `SESSION_LOCKS_TABLE`.
- **Unidentified holder**: If the key is missing or null, `resolveScheduleLockContention` treats it as this fire meeting its own lock.

#### Test Validation

**Source**: `/infra/lambdas/agent-cron/owner-contention-wait.test.ts`

The test suite validates:

- Wait when another schedule of the same owner holds the workspace
- Do NOT wait for duplicate delivery (same fire key)
- Do NOT wait without a fire claim (legacy/unclaimed contention)
- Do NOT wait on `lock-config` phase failures
- Do NOT wait when holder is unidentified
- Do NOT wait for earlier fire of same schedule (coalescing case)

**Test Command**:
```bash
cd infra/lambdas/agent-cron && bun test owner-contention-wait.test.ts
```

---

## Google Workspace Integration

**Documentation**: `/docs/features/agent-workspace-integration.md`

Per-user agents operate with their own Google Workspace identity (`agnt_<uniqname>@psd401.net`), delegated by users the same way they would delegate to a human assistant.

### Slot Model

| Slot | Identity | Auth Method |
|------|----------|-------------|
| **User slot** | Human's email | OAuth consent flow, refresh token in Secrets Manager |
| **Agent slot** | `agnt_*` account | Domain-wide delegation (DWD) token broker |

### DWD Token Broker (Security Hardening)

The DWD broker runs in an **isolated mint Lambda** (`psd-agent-mint-{env}`), not in the Next.js app, to prevent confused-deputy attacks:

```
API Route → IAM Invoke → Mint Lambda → WIF → Service Account → Google
                           ↑
                      Sole WIF Principal
```

If an attacker compromises the frontend, they can only invoke the mint Lambda—which always derives `agnt_<owner>` server-side—never arbitrary human identities.

### Account Provisioning

Agent accounts are provisioned automatically via OneSync sheet:
1. User requests agent action requiring workspace
2. Router detects unprovisioned account
3. Writes to OneSync `agents` sheet
4. Google creates `agnt_*` account within ~30 minutes

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| API Route | `/app/api/agent/workspace-token/` | Thin proxy to mint Lambda |
| API Route | `/app/api/agent/account-request/` | Auto-provisioning trigger |
| Mint Lambda | `/infra/lambdas/agent-mint/` | WIF token minting (isolated) |
| Workspace Skill | `/infra/agent-image/skills/psd-workspace/` | Google Workspace CLI wrapper |
| Cedar Policy | `/infra/policies/cedar/psd-agent-governance.cedar` | Capability allowlisting |

### Operation Allowlist

**Source**: `/lib/agent-workspace/command-executor.ts`

Google Workspace operations are classified into allowlist categories:

| Category | Description | Examples |
|----------|-------------|----------|
| `READ_ACTIONS` | Read-only operations, never mutate | `get`, `list`, `search`, `findDirectMessage` |
| `ALLOWED_WRITES` | User-slot permitted mutations | `gmail users settings filters`, `tasks tasks move` |
| `AGENT_ONLY_WRITES` | Agent-slot mutations only | `tasks tasks patch`, `tasks tasks update` |

**Removed Operations**: `drive +upload` is explicitly refused (both `ALLOWED_WRITES` and `AGENT_ONLY_WRITES`) because the Workspace CLI runs in an empty temp directory where container paths don't exist. Use `psd-publish-file` for publishing generated files to public URLs, or share via Drive manually.

The allowlist evolves based on production failure patterns.

| Operation | Reason |
|-----------|--------|
| `spaces.findDirectMessage` | DM lookup sends nothing; was refusing scheduled digests with no way to find target DM |
| `gmail users settings filters` | Inbox filter management; requires separate `gmail.settings.basic` scope |
| `tasks tasks move` | Task reordering within lists the user-slot can already insert into |

#### HTML Content Routing

**Source**: `/lib/agent-workspace/storage-broker.ts`

HTML files (`.html`) are **absent** from `PUBLIC_EXTENSIONS`. HTML artifacts go to Atrium—where they get an owner, visibility level, and publication record—never to public-by-link S3. This is enforced at the broker level, not just skill convention.

For HTML artifacts, use `psd-html-artifact` skill which creates an Atrium artifact with `--body-format html` and publishes to the internal reader surface.

#### Scope Gap Handling

Some operations require OAuth scopes not implied by existing grants. The `requiredWorkspaceScopeGap()` function detects these gaps and returns a user-facing capability description and re-authorization link:

```
gmail.modify ≠ gmail.settings.basic
```

When a user attempts Gmail filter operations without `gmail.settings.basic`, they receive a prompt to re-authorize with the additional scope rather than an opaque Google 403.

---

## Schedule Management

**Source**: `/app/api/agent/schedules/route.ts`

Schedule management routes use a **read/write split** for authorization:
- **Read operations** (`list`, `runs`): Accept both `owner` and `scheduled` mode
- **Write operations** (`create`, `update`, `delete`): Owner-only

This allows scheduled runs to audit their own schedules without mutating them. A scheduled-mode turn that attempts `create`, `update`, or `delete` receives a 403 after the same cryptographic verification as owner-mode requests.

The `SCHEDULED_READ_OPERATIONS` allowlist ensures new write operations default to owner-only rather than silently inheriting scheduled access.

### Scheduled Run Authoring Rules

**Source**: `/infra/agent-image/skills/psd-schedules/SKILL.md`

1. **Never hunt for the owner's own DM** — A scheduled run's reply IS the delivery. The platform delivers to the owner's Google Chat DM automatically; the model never chooses the destination and cannot change it. Prompts that instruct the agent to run `chat spaces.findDirectMessage` then `chat spaces list` then `chat +send` are dead code.

2. **Posting to shared spaces is legitimate** — While DM hunting is forbidden, `chat +send` to a shared space (team room, project channel) is correct when the schedule intends to notify a group.

---

## MCP Server

**Documentation**: `/docs/features/mcp-server.md`

AI Studio exposes its capabilities via Model Context Protocol (MCP) for external AI tools (Claude Code, Cursor, etc.).

### MCP Endpoint

```
POST /api/mcp
```

All MCP operations are authenticated via API keys with scoped permissions.

### Available Tools

Tools are projected from the app's registries in real-time:
- **Capability discovery** — `describe_capabilities` shows current tools
- **Assistant execution** — List and execute assistants
- **Decision capture** — Search and capture AI decisions
- **Content tools** — Atrium document operations
- **Agent workspace** — Google Workspace actions

### Scope Model

| Scope | Access |
|-------|--------|
| `mcp:list_assistants` | List available assistants |
| `mcp:execute_assistant` | Execute assistants |
| `content:read` | Read published content |
| `content:write` | Create/update content |

Key resolution follows a **shared-default, per-user-override** model:
- Default: Shared read-only `platform:read` key (discovery only)
- Override: User's personal API key (unlocks their full scopes)

---

## Cedar Governance

**Policy File**: `/infra/policies/cedar/psd-agent-governance.cedar`

All agent actions are validated against Cedar policies before execution.

### Governing Principles

1. **Allowlist principle** — Only explicitly permitted operations
2. **Least privilege** — Each skill gets minimum required capabilities
3. **Audit everything** — All actions logged with request context

### Policy Enforcement

```cedar
permit(principal, action, resource)
when { principal has capability && resource is allowed };
```

Policies are evaluated by the agent harness before each skill execution.

---

## Agent Identity & Auditing

### Identity Model

Agents operate with distinct identities tracked in `agent_identities` table:
- Human owner association
- Capability grants
- Audit trail linkage

### Audit Tables

| Table | Purpose |
|-------|---------|
| `agent_messages` | All agent communications |
| `agent_tool_invocations` | Tool calls made by agents |
| `agent_credential_reads` | Every credential access |
| `agent_credential_requests` | Permission to read credentials |
| `content_audit_logs` | Content creation/modification |

### Telemetry

Agent health monitoring via:
- `agent_health_snapshots`
- `agent_failures`
- `agent_patterns`

---

## Skill Publishing

**Documentation**: `/docs/features/skill-publishing.md`

Skills are published and managed through:
1. Admin interface at `/admin/agents/skills/`
2. Resource access grants for skill permissions
3. Audit of all skill operations

### Key Source Files

| File | Purpose |
|------|---------|
| `/infra/agent-image/skills/*/SKILL.md` | Individual skill definitions |
| `/lib/mcp/tool-handlers.ts` | MCP tool routing |
| `/lib/agent-workspace/` | Workspace integration logic |
| `/infra/lambdas/agent-router/` | Agent request routing |

---

## Related Concepts

- **[app-features/overview.md](../app-features/overview.md)** — Features agents interact with
- **[api-integration/overview.md](../api-integration/overview.md)** — External API access
- **[infrastructure/overview.md](../infrastructure/overview.md)** — Agent infrastructure deployment
