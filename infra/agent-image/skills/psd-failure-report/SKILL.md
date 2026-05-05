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
