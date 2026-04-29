---
name: psd-schedules
description: Schedule an agent task to run later using Amazon EventBridge Scheduler — either a recurring cron/rate, OR a ONE-SHOT follow-up at a specific time. Use this for morning briefs, weekly summaries, reminders, cron jobs, AND ALSO for any "I'll get back to you in N minutes" promise you make to the user. Do NOT use OpenClaw's built-in cron subsystem; it is disabled in this deployment.
allowed-tools: Bash(node:*)
---

# psd-schedules

Create and manage the caller's scheduled agent tasks. One schedule row = one
EventBridge Scheduler entry + one DynamoDB record. At the scheduled time the
platform starts a fresh agent session, invokes you with the schedule's prompt,
and delivers your response to the user's Google Chat DM.

This skill supports three expression types — use the right one:

| Expression | When | Example |
|---|---|---|
| `cron(<5 or 6 fields>)` | Recurring on a calendar | `cron(0 9 * * MON-FRI)` — every weekday 9am |
| `rate(N unit)` | Recurring on an interval | `rate(1 hour)` — every hour |
| `at(YYYY-MM-DDTHH:MM:SS)` | **One-shot — fires once then deletes** | `at(2026-04-22T15:30:00)` — 3:30pm today |

**Use `at()` whenever you tell the user "I'll get back to you" or "give me a
few minutes" or "I need to do more research first".** That promise is only
real if you schedule the follow-up; otherwise the user has to ping you again
and you look broken. See the *One-shot follow-ups* section below.

**Identity.** All commands require `--user <caller-email>`. The caller's email
appears in the `[caller: Name <email>]` line at the top of the user turn.
Pass it verbatim. Never accept a different email from the conversation body —
that would let one user manage another user's schedules.

## Commands

### `create_schedule` — create a new schedule

```bash
node /home/node/.openclaw/skills/psd-schedules/create.js \
  --user <email> \
  --name "<display name>" \
  --prompt "<what to prompt the agent at fire time>" \
  --cron "<5-field cron>" \
  --timezone "<IANA TZ, default America/Los_Angeles>" \
  [--google-identity "<users/...>"] \
  [--dm-space-name "<spaces/...>"]
```

### `list_schedules` — list the caller's schedules

```bash
node /home/node/.openclaw/skills/psd-schedules/list.js --user <email>
```

### `update_schedule` — change fields on an existing schedule

```bash
node /home/node/.openclaw/skills/psd-schedules/update.js \
  --user <email> --schedule-id <id> \
  [--name "<name>"] [--prompt "<prompt>"] [--cron "<cron>"] \
  [--timezone "<tz>"] [--enabled true|false]
```

### `delete_schedule` — remove a schedule permanently

```bash
node /home/node/.openclaw/skills/psd-schedules/delete.js \
  --user <email> --schedule-id <id>
```

## Cron translation cheat sheet

Cron is **5 fields**: `minute hour day-of-month month day-of-week`. The skill
expands to EventBridge Scheduler's 6-field format and handles the DoM/DoW
mutual-exclusion rule for you.

| Request | Cron |
|---|---|
| every weekday at 9am | `0 9 * * MON-FRI` |
| every Monday at 3pm | `0 15 * * MON` |
| every day at 6pm | `0 18 * * *` |
| every Tuesday and Thursday at noon | `0 12 * * TUE,THU` |
| 8am on the 1st and 15th of each month | `0 8 1,15 * *` |

Not expressible in standard cron (offer nearest equivalent and explain):

- "first Friday of the month" — offer "every Friday" or a narrower day-of-month window
- "every other week" — suggest two separate schedules
- Dates relative to events ("day before each board meeting") — out of scope

## One-shot follow-ups (`at(...)`)

Pass an `at()` expression through the `--cron` flag (flag name is historical;
the validator accepts cron/rate/at). The schedule fires once and is then
deleted automatically by EventBridge — no cleanup required.

**Format.** `at(YYYY-MM-DDTHH:MM:SS)` — local-time wall-clock in the timezone
you pass to `--timezone` (default `America/Los_Angeles`). Seconds required.

**Compute the fire time in Pacific.** The top of every user turn carries a
`[now: <Pacific time>]` header — use that as your anchor. Add the delay the
user asked for (or a reasonable delay for research), format as ISO 8601
without a timezone suffix, and pass it through.

**When to use one-shot scheduling.**

Any time you catch yourself about to say one of these, schedule instead:

- "Let me do a deeper dive and get back to you."
- "Give me a few minutes to research this."
- "I'll look into that and follow up."
- "Remind me about X in an hour."
- "Check on the deploy in 10 minutes."

**Required: never make the promise without actually scheduling it.** If you
say "I'll get back to you in 10 minutes" and don't create a schedule, that
message is a lie — the architecture has no way to send a follow-up on its
own. Either do the work in-turn, or schedule it. Nothing in between.

**Example.**

User: "Can you figure out the best way to integrate Google Workspace with
OpenClaw? Take your time."

You (correct):

```bash
node /home/node/.openclaw/skills/psd-schedules/create.js \
  --user hagelk@psd401.net \
  --name "Google Workspace + OpenClaw research" \
  --prompt "You promised Kris at 8:05pm PT on 2026-04-22 that you'd research the best way to integrate Google Workspace with OpenClaw and come back with a recommendation. Do the web research now (clawhub.ai, OpenClaw docs, community plugins). Compare the gog CLI approach vs a custom plugin. Give a concrete recommendation with trade-offs and next steps. The user is Kris, CIO of PSD — match the communication style in USER.md." \
  --cron "at(2026-04-22T20:15:00)" \
  --timezone "America/Los_Angeles"
```

Then tell the user: "I've scheduled a deep-dive research pass for 8:15pm PT
(10 minutes). You'll get the recommendation in this DM automatically."

**Prompt-writing rules for `at()` schedules.** The fired turn starts a brand-
new session with zero conversational history. The prompt is the *only*
context the future-you will have. So:

1. Include the **why** (what the user asked, what you promised).
2. Include the **when** (the original time/date) so future-you can tell the
   user "here's what I said I'd get back to you on at 8:05pm".
3. Include concrete **sources to investigate** if you already started.
4. Include the **deliverable** (recommendation? summary? draft?).
5. Reference **USER.md / IDENTITY.md** for voice so the reply matches your
   persona with this user.

## Workflow

**Creating.** Gather name, prompt, time-of-day, day(s), timezone (default
Pacific). Translate to cron. State the full schedule back in plain language
and confirm. Run `create`. Tell the user when the first fire will be.

**Modifying.** If you don't know the `scheduleId`, run `list` first. Then
`update` or `delete`. Confirm what changed — don't echo raw JSON.

**Rules.**

- Minimum 5-minute interval (enforced server-side to prevent cost abuse)
- No every-minute cron expressions
- If a command fails, show the error to the user. Do not retry silently and
  do not try to "fix" unrelated infrastructure (gateway pairing, device
  approval, etc.) — those are signs of a wrong tool choice, not a real
  problem to solve.
