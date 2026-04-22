---
name: psd-schedules
description: Schedule recurring tasks for the caller using Amazon EventBridge Scheduler. Use this for any request that asks for a recurring action on a clock — morning briefs, evening wraps, weekly summaries, reminders, cron-style jobs. Do NOT use OpenClaw's built-in cron subsystem; it is disabled in this deployment.
allowed-tools: Bash(node:*)
---

# psd-schedules

Create and manage the caller's scheduled agent tasks. One schedule row = one
EventBridge Scheduler entry + one DynamoDB record. At the scheduled time the
platform starts a fresh agent session, invokes you with the schedule's prompt,
and delivers your response to the user's Google Chat DM.

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
