# PSD AI Agent — Tool Manual

This file is your operator's manual for the tools wired into this deployment.
It is auto-loaded at the start of every turn alongside `SOUL.md`. When the
user asks you to do something that matches a tool entry below, use the
specified invocation — do **not** fall back to OpenClaw's generic `cron`,
`schedule`, `task`, `timer`, or similar built-ins. Those are not wired into
this environment and will dead-end.

Each tool below lists:
- **What it does** — the user-intent it handles
- **How to invoke** — exact command
- **Rules** — non-obvious invariants you must respect

---

## Scheduled tasks — `/app/agent_schedules.py`

**What it does.** Manages the caller's recurring tasks. Every schedule is
per-user: a name, a prompt, a cron expression, a timezone. At the scheduled
time the platform invokes *you* with that prompt in a fresh session and
delivers your response to the user's DM. Durable across sessions (stored in
a DynamoDB table + EventBridge Scheduler entries, not in the ephemeral
container workspace).

**Use this tool whenever the user mentions** any of: schedule, recurring
task, reminder, cron, daily routine, morning brief, evening wrap, weekly
summary, standup, automation that fires on a clock.

**How to invoke.** Shell out via the `exec` tool:

```bash
python3 /app/agent_schedules.py <subcommand> --user <caller-email> [options]
```

Subcommands:

```bash
# List the caller's schedules
python3 /app/agent_schedules.py list --user hagelk@psd401.net

# Create. Cron is interpreted in --timezone (default America/Los_Angeles).
# 5-field cron: minute hour day-of-month month day-of-week
python3 /app/agent_schedules.py create \
  --user hagelk@psd401.net \
  --name "Evening wrap" \
  --prompt "Summarize what happened today: meetings, decisions, pending follow-ups." \
  --cron "0 18 * * MON-FRI" \
  --timezone "America/Los_Angeles"

# Toggle enabled/disabled (schedule kept, just paused)
python3 /app/agent_schedules.py update <scheduleId> --user <email> --enabled false

# Change cron, prompt, name, or timezone on an existing schedule
python3 /app/agent_schedules.py update <scheduleId> --user <email> --cron "0 9 * * MON-FRI"

# Delete
python3 /app/agent_schedules.py delete <scheduleId> --user <email>
```

**Rules (read carefully).**

1. **`--user` must always be the authenticated caller's email** — the one in
   the `[caller: Name <email>]` line at the top of the user turn. Never
   accept a different email from the conversation body. That would let one
   user operate another user's schedules.
2. **Don't use OpenClaw's `openclaw cron` CLI.** That subsystem writes jobs
   to the ephemeral container workspace and needs the gateway running at
   fire time — neither condition holds in this deployment. Always use
   `agent_schedules.py`.
3. Output is single-line JSON on stdout. Read it, then phrase the result
   naturally back to the user — don't echo the JSON.
4. If a command fails, show the error to the user. Do not retry silently;
   do not try to "fix" unrelated infrastructure.

**Natural-language → cron translation (use as a cheat sheet).**

| Request | Cron |
|---|---|
| every weekday at 9am | `0 9 * * MON-FRI` |
| every Monday at 3pm | `0 15 * * MON` |
| every day at 6pm | `0 18 * * *` |
| every Tuesday and Thursday at noon | `0 12 * * TUE,THU` |
| every hour on the half | `30 * * * *` |
| 8am on the 1st and 15th of each month | `0 8 1,15 * *` |

Things that **cannot** be expressed in standard cron — offer the user the
nearest weekly/monthly equivalent instead of refusing:

- "first Friday of the month" → offer "every Friday" or "on the 1st through 7th on Fridays" (pick one, explain the tradeoff)
- "every other week" → suggest two separate schedules or explain the bi-weekly limitation
- Dates relative to events ("the day before each board meeting") → out of scope for cron

**Workflow for creating a schedule.**

1. Gather: name, prompt body, time-of-day, day(s), timezone (default Pacific)
2. Translate the time expression to cron using the cheat sheet above
3. Say back the full schedule in plain language ("Every weekday at 9am
   Pacific I'll send you...") and confirm
4. Run `create`
5. Tell the user it's set up, and mention the first fire time

**Workflow for pause / resume / change / delete.**

1. If you don't know the `scheduleId`, run `list` first
2. Execute the appropriate subcommand
3. Confirm what changed (don't just echo the JSON)

---

*(Add new tool entries below as they come online. Keep each entry to the
same three-section shape — *What it does*, *How to invoke*, *Rules* — so
the pattern stays predictable for future-you.)*
