# Email Triage — Operations

Smart email triage for the PSD AI Agent. Phase 1 — agent-native opt-in,
per-user rules, Gmail labels, Bedrock Nova Micro fallback classifier,
Chat escalations, daily digest, admin sub-page.

Plan: `/Users/hagelk/.claude/plans/everything-is-good-to-graceful-twilight.md`

Phase 2 tracker: <https://github.com/psd401/aistudio/issues/996>

---

## Architecture at a glance

```
User in Chat ───────────► PSD AI Agent (existing OpenClaw container)
                            │ tool call
                            ▼
                  psd-email-triage skill
                  (read/write rules, create Gmail labels,
                   schedule digest)
                            │
                            ▼
               psd-agent-triage-<env>   ◄────────── reads every 5 min
               (DynamoDB, one row/user)             ┌─────────────────────────────┐
                            ▲                       │ psd-agent-triage-poll-<env>  │
                            │                       │ Lambda — rate(5 minutes)    │
                            │ records               │  Gmail history → rules →    │
                            │ decisions             │  Nova Micro → labels →      │
                            │ corrections           │  Chat escalation card       │
                            │                       └─────────────────────────────┘
                            │
               ┌────────────┴─────────────┐
               │                          │
               ▼                          ▼
   psd-agent-triage-digest-<env>     /admin/agents/[userEmail]/triage
   Lambda — daily per user           Admin read-only view + support actions
   (EventBridge Scheduler)
```

Three deployable artefacts:
- DynamoDB table `psd-agent-triage-<env>` (added in `infra/lib/agent-platform-stack.ts`).
- Two Lambdas (`agent-triage-poll`, `agent-triage-digest`) under `infra/lambdas/`.
- One skill (`psd-email-triage`) bundled into the agent image.

Plus one Next.js admin page (`/admin/agents/[userEmail]/triage`).

---

## Onboarding (user-facing)

```
User: "Hey agent, start triaging my email"
Agent: <enable card; user clicks [Yes]>
Agent calls: node /opt/psd-skills/psd-email-triage/run.js enable --user <email>
```

The skill:
1. Calls the user's `user_account` OAuth slot (requires the
   `gmail.modify` scope, already granted as of PR #913).
2. Creates 3 Gmail labels: `@psd/Important`, `@psd/Later`, `@psd/News`
   (nested under `@psd` because Gmail treats `/` as hierarchy — confirmed
   via smoke test 2026-05-21).
3. Captures Gmail's current `historyId` so the classifier only sees mail
   that arrives AFTER opt-in (no retroactive classification — that's a
   Phase 2 item).
4. Seeds default rules: a small `muteSenders` list for `noreply@*`-style
   patterns and two keyword rules (newsletter → news; external+urgent →
   later as anti-spam-spoof).
5. Creates an EventBridge Scheduler entry for the daily digest (default
   08:00 in user's tz).

The classifier Lambda starts processing on the next 5-minute tick.

---

## Per-email pipeline (classifier Lambda)

For each opted-in user every 5 minutes:

1. **Refresh access token** via `workspace-token.ts` (Lambda-local copy
   of the helper in `lib/agent/`; reads the user's `user_account` slot
   from Secrets Manager, exchanges refresh token for an access token).
2. **Pull Gmail history** since `lastHistoryId` (only `messageAdded`,
   `labelAdded`, `labelRemoved` events).
3. For each new message: **deterministic rules first** (VIP → important,
   mute → later, thread-with-user-reply → important, keyword rules in
   order). If undecided, **call Bedrock Nova Micro** with a small system
   prompt summarising the user's rules + sender/subject/snippet. Default
   to `later` if model confidence < 0.6.
4. **Apply Gmail label** via `messages.modify`. **All three labels also
   remove `INBOX`** — the design treats labels as mutually-exclusive
   folders so the user reviews each in one place. Inbox empty = triage
   caught up. The Chat escalation is the "look at this now" signal
   for the rare cases that warrant interruption.
5. **Maybe escalate to Chat** — if the label matches the user's
   `escalation.labelTriggers` AND (no sender/keyword filter OR the
   sender/keyword matches), post a card to the user's DM via the Chat
   API.
6. **Detect user-driven label changes** — if a recent classification
   contradicts what the user just did (e.g. they moved an `@psd/Later`
   message back into Inbox), record as a `recentCorrections` entry
   (Phase 1 only records; Phase 2 acts on them).
7. **Advance the cursor** in DDB.

---

## Operational knobs (env vars)

`psd-agent-triage-poll` Lambda:

| Env var | Default | What it does |
|---------|---------|--------------|
| `TRIAGE_TABLE` | `psd-agent-triage-<env>` | DDB table name |
| `TRIAGE_USER_BATCH` | `10` | Users processed in parallel per batch within a tick |
| `TRIAGE_LLM_MODEL_ID` | `us.amazon.nova-micro-v1:0` | Bedrock model for the ambiguous-classification fallback. Set to `us.anthropic.claude-3-5-haiku-...` to swap to Haiku without a redeploy (the role grants both). |
| `GOOGLE_CREDENTIALS_SECRET_ARN` | (set by CDK) | Chat-bot service-account JSON for escalation posts |
| `AWS_REGION` | (Lambda runtime) | DDB / Bedrock / Secrets region |

`psd-agent-triage-digest` Lambda:

| Env var | What it does |
|---------|--------------|
| `TRIAGE_TABLE` | DDB table |
| `GOOGLE_CREDENTIALS_SECRET_ARN` | Chat creds for the digest card |

Agent skill (in the container, env injected by `agent-platform-stack.ts`):

| Env var | What it does |
|---------|--------------|
| `TRIAGE_TABLE` | DDB table |
| `EVENTBRIDGE_SCHEDULE_GROUP` | Scheduler group for digest entries |
| `EVENTBRIDGE_ROLE_ARN` | Role the Scheduler assumes to invoke the digest Lambda |
| `TRIAGE_DIGEST_LAMBDA_ARN` | Target for the per-user digest schedule |

---

## Smoke-test sequence (post-deploy)

1. **Stack deploys cleanly** —
   ```
   cd infra && bunx cdk diff AIStudio-AgentPlatformStack-Dev
   ```
   Expect: new DDB table, two Lambdas, EventBridge Rule, log groups.
2. **Agent image rebuilds** —
   ```
   cd infra/agent-image && ./build-and-push.sh $(date +%Y-%m-%d)-email-triage
   ```
   Expect: image layer count stays under 54 (Phase 1 estimate: 50 with
   the new skill's npm install).
3. **Opt-in test** — DM the agent: "start triaging my email". Click
   `[Yes, start watching]`. Verify:
   - Gmail sidebar shows the three labels under the `@psd` group.
   - DDB row created (`enabled=true`, `classifierStartHistoryId` set).
   - Admin sub-page renders cleanly at
     `/admin/agents/<your-email>/triage`.
4. **Classification smoke test** — send yourself a known spammy email
   from an external address with "urgent" in the subject. Wait one
   poll cycle. Expect: `@psd/Later`, archived from Inbox, no Chat ping.
5. **VIP escalation** —
   - In Chat: "Always page me from <colleague>@psd401.net"
   - Have that colleague send you a test message.
   - Expect: `@psd/Important` label, **and** a Chat card escalation.
6. **Training correction** — in Gmail, move one of the `@psd/Later`
   messages back to Inbox manually. After the next poll, in Chat: "show
   recent corrections". Expect: a correction row.
7. **Daily digest** — in Chat: "digest time 17:00" (or near-future).
   Wait. Expect: a card lands in your DM at that time with sections per
   label.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Skill returns `code: "needs-auth"` on enable | User hasn't done `user_account` OAuth | Send them the consent link via the existing workspace flow |
| Skill returns `code: "needs-auth"` on rules update after a working enable | Refresh token revoked (Google admin or user revoked) | Run the consent flow again |
| Classifier Lambda logs `cursor_too_old_reset` | User's `lastHistoryId` is > 7 days old (Gmail history retention) | Self-healing — Lambda re-anchors to current historyId |
| Classifier Lambda logs `llm_classify_failed` | Bedrock throttle, model unavailable, or prompt-too-large | Check CloudWatch for upstream error; classifier safely defaults to `later` for those messages |
| All classifications return `later` regardless of content | Model confidence floor (0.6) not being met — investigate prompt or swap model | Set `TRIAGE_LLM_MODEL_ID=us.anthropic.claude-3-5-haiku-...` |
| Daily digest never arrives | EventBridge Scheduler entry missing or Scheduler can't invoke the Lambda | Check `aws scheduler get-schedule --group-name psd-agent-<env> --name triage-digest-<userslug>` |
| Admin sub-page shows "No triage row" but user says triage is on | DDB row was deleted (admin re-onboard) but user hasn't re-enabled yet | User runs `enable` again from chat |
| Escalation posts not appearing in Chat | DM space resource name missing on the triage row OR Chat bot lacks DM space access | Check `dmSpaceName` field in DDB row; the user must have DM'd the bot at least once |

---

## Phase 1.5 — `@psd/Task` user-gesture task creation

The `@psd/Task` label is a fourth default label the user can apply
manually in Gmail. The classifier never assigns it. When the polling
Lambda detects a user-applied `@psd/Task` label, it (optionally)
invokes AgentCore so the user's agent creates a task in their
preferred task system (Life OS, Google Tasks, anything they've
configured a skill for).

### Behaviour matrix

| `tasksMode` | Behaviour on `@psd/Task` label |
|-------------|--------------------------------|
| `none` (default) | Lambda does nothing. The message keeps the `@psd/Task` label. Useful for users who want the label as a manual holding bay with no automation. |
| `invoke-agent` | Lambda invokes AgentCore with the email metadata. The user's agent reads their `MEMORY.md` to determine how to create the task (which skill, which system, which labels). On success: email is archived (both `INBOX` and `@psd/Task` removed) — end state is All Mail only. On failure: email is left alone and a Chat card surfaces the failure reason. |

### Required agent-side configuration

For `invoke-agent` to work, the user adds a memory entry telling the
agent how to handle the request. Example for a Life OS user:

```markdown
## Email Triage → Life OS Task Creation

When the email-triage system invokes you with a prompt tagged
`[psd-email-triage task request]`, create a GitHub issue in
krishagel/life-os:
  - Title: the email's subject
  - Body: from + Gmail link + snippet
  - Labels: status:inbox, priority:p2, type:task, source:email, owner:hagel

Reply with one line:
  - Success: `Created life-os issue #<n>: <title>`
  - Failure: `FAILED: <reason>`

No additional commentary.
```

A Google Tasks user writes the equivalent telling the agent to call
the `gws-tasks` skill instead.

### Reply contract (parsed by Lambda)

```
Created <system> <type> <id>: <title>     ← success
FAILED: <reason>                          ← failure
```

`<system>` and `<type>` are user-defined (e.g. `life-os issue`, `google-tasks task`). `<id>` is whatever identifier the user's task system returns (e.g. `#1234`, `abc-xyz`). The Lambda extracts the id for the audit trail; it doesn't try to interpret `<system>` or `<type>` beyond matching the line pattern.

### Dedup

Thread-level labelling is naturally dedup'd: when the agent succeeds, the Lambda removes the `@psd/Task` label from the message AND removes INBOX. Subsequent thread activity arrives without `@psd/Task`, so no re-fire. To retry after a failure, the user removes and re-adds the label manually (deliberate gesture → fresh attempt).

### Latency

Same 5-minute polling window as the classifier (no Phase 1.5 push). The user labels an email and waits up to 5 minutes for the task to appear in their task system. The agent invocation itself adds another 10–30 seconds. Users get a Chat confirmation card if `tasks notify-success on` is set.

### Cost

Each task gesture invokes AgentCore once (~$0.01–0.05 per invocation depending on the agent's reasoning length). At typical tasking volumes (5–20 per day per power user) this is negligible.

---

## Phase 1 known limitations

Listed here, all tracked in #996:
- No Gmail push subscription — escalations are bounded by the 5-minute polling cadence.
- No retroactive classification — only mail received after enable gets sorted.
- `learnedPatterns` array is populated by Phase 2; Phase 1 only records `recentCorrections`.
- Single-Lambda scan over all opted-in users — caps at 1000 per invocation. Fan-out comes with Phase 2.

---

## Costs at scale (1000 users projection)

- Bedrock Nova Micro at ~$0.0001/classification × ~50 ambiguous emails/user/day = $0.005/user/day = ~$1825/yr.
- DynamoDB at on-demand pricing with 1000 users × ~3 writes/min during business hours ≈ negligible (<$50/yr).
- Lambda execution (5-min poll × 1000 users sequentially batched 10-at-a-time) ≈ $400/yr.

Aggregate: comfortably under $3k/yr for the whole org, before any cost optimisations.

---

## Files touched in Phase 1

- `infra/lib/agent-platform-stack.ts` — table, both Lambdas, EventBridge Rule, env vars.
- `infra/lambdas/agent-triage-poll/` — classifier Lambda + unit tests for rules + LLM parser.
- `infra/lambdas/agent-triage-digest/` — digest Lambda.
- `infra/agent-image/skills/psd-email-triage/` — agent skill.
- `infra/agent-image/Dockerfile` — npm install for the new skill (+1 layer).
- `lib/agent/workspace-token.ts` — canonical TS token helper (Lambdas keep a local copy).
- `app/(protected)/admin/agents/[userEmail]/triage/` — admin sub-page.
- `actions/admin/agent-triage.actions.ts` — admin server actions.
- This file.
