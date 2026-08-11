# Agent usage telemetry: outage and backfill

## What broke

OpenClaw `2026.7.2-beta.5` moved per-session transcripts out of

```
/home/node/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

into a per-agent SQLite database

```
/home/node/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
  table transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)
```

and **deleted the JSONL files** (the migrated originals are archived under
`agents/<agentId>/session-sqlite-import-archive/`).

`harness_adapter._read_turn_usage()` — the only source of per-turn token usage on
the post-#1384 SigV4 path — kept opening the JSONL path. It found nothing and
returned honest zeros.

**Nothing failed.** A zero read is indistinguishable from a genuine zero once it
reaches `agent_messages`, so:

- every turn recorded `input_tokens = output_tokens = cache_read_input_tokens = 0`
- `admin/agents` → Cost tab showed `$0`
- no error, no alarm, no failed turn, for **ten days**

Dates: **dev from 2026-07-31**, **prod from 2026-08-01**.

**Caching was never broken.** A checkpointed workspace database shows the healthy
steady state throughout: ~2 billable input tokens against a 54k–71k-token cache
read per turn. Only the telemetry regressed.

## What was fixed

| Area | Change |
|---|---|
| Read path | `harness_adapter` reads `transcript_events` (read-only URI, bound `session_id`, `created_at >= since_ms` prefilter, `ORDER BY seq`). JSONL remains a fallback for older hosts. |
| Model id | `AGENT_MODEL_ID` corrected to `us.anthropic.claude-sonnet-5`, the id actually recorded since 2026-07-31. |
| Observability | `agent_messages.usage_capture_complete` (migration 177) + the `UsageCaptureZero` metric and alarm. |
| History | The backfill below. |

### Why `ORDER BY seq`, not `created_at`

Verified against a real checkpointed database: `created_at` is only *weakly*
ordered against `seq` — **28 of 32 sessions** contain a row whose `created_at`
precedes that of a lower `seq`. Turn completeness is decided by the **last**
record, so ordering by `created_at` misreads it.

`created_at >= since_ms` is still a safe **prefilter** because `created_at` is
always at or after the record's own `message.timestamp` (488 records, 0
inversions, skew 0–19,941 ms). It narrows the scan without hiding an in-window
record; the authoritative window test stays on the record timestamp.

## The backfill

The transcripts survive in the S3-checkpointed workspaces, so the real numbers
are recoverable.

```bash
# DRY RUN (default — reads only, writes NOTHING)
AGENT_WORKSPACE_BUCKET=psd-agents-dev-390844780692 \
DB_CLUSTER_ARN=arn:aws:rds:us-east-1:390844780692:cluster:aistudio-dev-cluster \
DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:390844780692:secret:DbSecret685A0FA5-Tby3OSNjVCjb-i3YrMv \
bun run db:backfill-agent-usage -- --since=2026-07-30

# EXECUTE (requires BOTH flags)
... bun run db:backfill-agent-usage -- --since=2026-07-30 \
      --execute --confirmation=BACKFILL_AGENT_USAGE
```

Flags: `--prefix=<workspace>` limits to one workspace; `--since=<ISO date>`
bounds which `agent_messages` rows are considered.

> **Prerequisite:** migration 177 must be applied first — the script reads and
> writes `usage_capture_complete`.

### Turn attribution

This is the part that matters. `agent_messages.session_id` is a PSD *sessionKey*
(`agent-chat-<sha256>`), **not** the OpenClaw transcript UUID. The mapping lives
in the transcript itself:

```
session_windows.session_key = "agent:main:" + agent_messages.session_id
```

Up to **8 rows (turns)** share one sessionKey, and the transcript is append-only
across all of them — so summing a session into one row would inflate it by the
entire session history.

**Row timestamps cannot be used as turn boundaries.** The obvious model — turn
*k* covers `(created_at[k-1], created_at[k]]` — is wrong. The router releases the
session lock in the `finally` of its invocation wrapper but does not insert the
telemetry row until after the Google Chat response is sent, so the next turn can
begin and write transcript records *before* the previous turn's row is stamped.
The windows overlap and calls get billed to the wrong row.

So the **transcript** is segmented by its own turn structure, and the rows supply
only order and count:

1. Walk the session's records in append order, cutting a segment after each
   record whose `stopReason` is terminal (`stop` / `end_turn`). OpenClaw writes
   `toolUse` on every call that hands off to a tool, so a terminal reason is
   exactly the end-of-turn marker.
2. Drop a trailing segment with no terminal reason — an in-flight or aborted
   turn, which has no row yet.
3. Pair segment *k* with row *k*, rows ordered by `created_at`.
4. **If the counts disagree, attribute nothing and report it.** A mismatch means
   the model of the session is wrong, and guessing would silently misprice turns.

Two consequences worth knowing:

- The plan needs **every** row of a session, including already-populated ones. A
  populated row still consumes a segment; loading only the zero rows would slide
  every later segment onto the wrong row.
- `--since` is applied to the resulting **updates**, never to the query. Removing
  a session's earlier rows would delete the anchors that establish its turn
  order.

Step 4 is also what contains the two things that could otherwise corrupt
attribution: a duplicate `agent_messages` row (the router's insert carries no
idempotency key), and a terminal record that carries no `usage` object (dropped
at parse time, so its segment never gets cut). Both surface as a reported count
mismatch rather than a mispriced turn.

### Safety properties

- **Dry-run is the default.** Writing needs `--execute` **and** the exact
  confirmation token — no single typo can mutate telemetry.
- **Idempotent.** Every `UPDATE` re-asserts "all four token counters are still
  zero" in its `WHERE` clause, enforced by the database at write time rather than
  by the plan computed earlier. A second run updates 0 rows, and a row the fixed
  live capture has since populated is never clobbered.
- **Fills only zero rows.** It cannot overwrite a real measurement.
- **Reconciliation is printed before any write:** transcript totals vs planned
  totals vs unattributed model calls.
- One unreadable workspace is logged and skipped, not fatal.

The `-wal` sidecar is deliberately **not** fetched: a checkpointed database may
carry a stale WAL from an earlier upload, and pairing a current `.sqlite` with an
older `-wal` can surface a torn state. Reading the main file alone may miss the
most recent uncheckpointed turns, which under-counts rather than corrupting.

### Reading the report

| Line | Meaning | Action |
|---|---|---|
| `rows to update` | Recoverable rows | The backfill's value |
| `rows with NO transcript coverage (unrecoverable)` | No covering record, **or** covering records that carry no usage themselves | Expected for pre-2026-07-29 rows; nothing to recover |
| `unattributed model calls` | Records no paired segment claimed — a trailing in-flight turn, or every record of a session that was skipped | **Non-zero means the plan under-counts — investigate before executing** |
| `turn count mismatches` | Sessions whose completed-turn count ≠ row count, so nothing was attributed | **Investigate before executing: recoverable in principle, but the session model is wrong** |

Rows before ~2026-07-29 are unrecoverable *by design of the data*: the
transcripts of that era carry the model calls but no usage numbers on them, so
there is nothing to restore. The script reports them as unrecoverable rather than
writing zeros over zeros and claiming success.

### Dry-run result on dev (2026-08-10)

Against `psd-agents-dev-390844780692`, `--since=2026-07-25`:

```
transcript sessions: 32   parsed usage records: 229
dev zero rows: 75   non-zero rows: 21
rows to update: 57
rows with no coverage: 2
unattributed model calls: 6
planned totals: input=651,790  output=51,724
                cacheRead=10,207,165  cacheWrite=2,600,380
```

The recovered rows show the healthy caching pattern the outage hid, e.g.
`input=2, output=473, cacheRead=54,256, cacheWrite=121`.

The 6 unattributed calls are records past the newest `agent_messages` row plus
background (non-`agent-chat-`) sessions that have no telemetry row by design.

## Preventing a repeat

`UsageCaptureZero` (namespace `PSD/AgentPlatform/<env>`) counts turns that
**succeeded and made at least one model call yet reported zero tokens** — which
is arithmetically impossible for a real turn. Alarm
`psd-agent-usage-capture-zero-<env>` fires at ≥ 5 in 5 minutes: a rare edge turn
can trip the heuristic once, but a broken capture path trips it on every turn.

> **Deploy note:** without `--context alertEmail=<address>` the agent alarm topic
> is not created, and this alarm — like all existing agent-platform alarms —
> evaluates correctly and notifies nobody. The stack emits a synth warning for
> that case.

`agent_messages.usage_capture_complete` is the persisted counterpart and is
deliberately **nullable**: `true` = measured, `false` = the read did not complete
(token columns are a floor, not a total), `null` = unknown (row or reporting
image predates the column). Consumers must handle all three.
