---
name: psd-failure-report
summary: Self-report when you cannot fulfill a request — logs to agent_failures so admins can triage systemically.
description: When you cannot complete what the user asked for (missing data, missing credentials, an unavailable tool, an ambiguous instruction you cannot resolve, a task you started but did not finish), call this skill BEFORE responding to the user. It writes a row to agent_failures so admins can systematically work through recurring problems. Calling this is non-negotiable when applicable.
allowed-tools: Bash(node:*)
---

# psd-failure-report

Self-report a failure you encountered. **Always call this before responding to the user when you could not fulfill any part of their request.**

## When to call

Call `report` when ANY of the following is true:

- You needed a credential or API key and could not get one (`reason: missing_credentials`).
- A tool returned an error you could not work around (`reason: tool_error`).
- A tool you needed is not available in this environment (`reason: tool_unavailable`).
- A data source returned no results when the user clearly expected results (`reason: data_not_found`).
- The user's instruction was ambiguous and you had to guess (`reason: ambiguous_request`).
- You started a task and did not finish it (`reason: task_incomplete`).
- Anything else that means the user did not get what they asked for (`reason: other`).
- **The user tells you something you produced did not work** — a chart with no
  image, a document they cannot open, a link that 404s, an empty or truncated
  reply, a file that never arrived (`reason: tool_error`, or `other` if no tool
  is implicated). Report it even when every tool you called returned success.

That last one is not optional, and it is the one most easily missed. Every
trigger above it describes a failure *you* observed; this one describes a
failure only the USER can observe. When a tool exits 0 and emits something
malformed — a card whose image never loads, a URL that resolves to nothing —
you have no way to detect it, so from your side the turn looks clean and no
report gets written. The user telling you is the ONLY signal that exists.

**Their report is the evidence. Your exit codes are not.** Do not argue that the
tool succeeded, do not ask them to refresh first, and do not wait to reproduce
it. Log it, then help them. If they mention it again, that is a second
occurrence — log it again rather than assuming the first report covered it.

If in doubt: **call it**. False positives are cheap; silent failures are expensive.

## Command

```bash
node /opt/psd-skills/psd-failure-report/report.js \
  --user <caller-email> \
  --reason <category> \
  --details "<what you were trying to do and why it didn't work>" \
  [--tool <tool-name>] \
  [--user-facing true|false]
```

Returns `{"logged": true, "failure_id": <int>}` on success. Returns `{"logged": false, "reason": "..."}` if the database is unavailable (still safe to proceed — the failure is logged to CloudWatch).

`--user-facing` (default `true`): when `true`, your reply to the user should also acknowledge what went wrong. When `false`, this is a silent telemetry-only report (use sparingly).

**Execution and evidence contract:** "call `report`" means you must actually
invoke `report.js` before replying. Planning the call, describing it, or
claiming that it happened is not a report. Say the failure was logged only
after stdout returns `"logged": true`, and include the returned `failure_id`.
Use the exact user-facing label `Failure ID: <failure_id>`; never rename it
`Record ID`, `Report ID`, or `Ticket ID`.
If stdout returns `"logged": false`, say that the database log failed and do
not invent an ID or claim success.

## Examples

```bash
# Missing credential
node /opt/psd-skills/psd-failure-report/report.js \
  --user alice@psd401.net \
  --reason missing_credentials \
  --details "Tried to fetch calendar events but no google_oauth credential was provisioned for this user."

# Empty data result
node /opt/psd-skills/psd-failure-report/report.js \
  --user bob@psd401.net \
  --reason data_not_found \
  --details "User asked for today's morning brief but no events, emails, or chat messages were returned. Likely missing OAuth grants or tool failures upstream."
```

After calling this skill, write your normal user-facing reply (which should explain what went wrong unless `--user-facing false`).
