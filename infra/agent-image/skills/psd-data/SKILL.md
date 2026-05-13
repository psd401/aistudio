---
name: psd-data
summary: Query the PSD data warehouse via the psd-data-mcp server. Authenticates as the calling user, enforces row-level security, exposes 8 tools (tables, schema, permissions, query, lessons).
description: Read-only access to PSD's Redshift data warehouse, authenticated with the caller's Cognito identity. Lists tables, inspects schemas, runs RLS-rewritten SELECT queries, and manages cross-session "lessons" learned about the data. The MCP server enforces all access control — the skill simply forwards JSON-RPC calls with the right bearer token.
allowed-tools: Bash(node:*)
---

# psd-data

Access to the PSD data warehouse (Redshift) via the `psd-data-mcp` server.

**Every command requires `--user <caller-email>`** (the email from the
`[caller: Name <email>]` header at the top of each user turn). The skill
uses that email to look up the caller's stored Cognito refresh token,
mint a fresh id_token, and authenticate to the MCP server as the user.

## Authentication

You do not handle authentication directly. The skill:

1. Reads the caller's refresh token from Secrets Manager at
   `psd-agent-creds/${ENVIRONMENT}/user/${email}/cognito-refresh`.
2. If the secret is missing or revoked, the skill **emits a `needs-auth`
   payload and exits 10** — same shape as `psd-workspace`. Follow the rule-9
   convention: paste `consent_chat_hyperlink` on its own line, no surrounding
   markdown, then on a *separate* line explain that the user needs to
   authorize data access. Do not retry the command after a `needs-auth`.
3. On success, exchanges the refresh token for a fresh Cognito id_token
   and sends it to the MCP server as `Authorization: Bearer …`.
4. Row-level security applies server-side — the user sees only the data
   the warehouse says they may see.

## Exit codes

| Code | Meaning | Agent response |
|------|---------|----------------|
| 0 | Success — JSON-RPC result on stdout | Use the result |
| 1 | Config / usage error | Surface the error, do not retry |
| 10 | needs-auth: no token, or token revoked | Paste `consent_chat_hyperlink` on its own line |
| 12 | Upstream MCP error (JSON-RPC error or unexpected HTTP) | Surface the error verbatim |
| 13 | Forbidden: user not in `userpermissions` table | Tell the user to ping the data team |
| 14 | Rate-limited: 60 req/min/user | Wait a minute, retry once |

The MCP server itself returns useful error messages — surface them
verbatim instead of inventing your own explanation.

## Subcommands

The 8 typed subcommands below cover the tools the MCP server exposes today
and validate their arguments before sending. For **anything not listed
here** — including new tools the server may add after this skill was
shipped — use the **`list` + `call` discovery pair** at the bottom.
Hardcoded subcommands are a convenience, not a fence; the agent is never
limited to them.

### `list` — discover available MCP tools

```bash
node /opt/psd-skills/psd-data/run.js list --user <caller-email>
```

Returns the MCP server's current `tools/list` response: every tool name,
description, and JSON-Schema `inputSchema`. **Use this first** if:

- You're not sure whether a typed subcommand below covers what you need
- The server might have added new tools since this skill was built
- A typed subcommand returns a `MethodNotFound` or schema-mismatch error

### `call` — generic passthrough to any MCP tool

```bash
node /opt/psd-skills/psd-data/run.js call --user <caller-email> \
  --tool <tool-name> \
  --args '{"arg1": "value", "arg2": 42}'
```

`--args` is a JSON object matching the tool's `inputSchema`. Always run
`list` first so you can craft a correct args object. Use this when a
typed subcommand doesn't exist for the tool you need.

### `tables` — list every table the user can see

```bash
node /opt/psd-skills/psd-data/run.js tables --user <caller-email> [--detailed]
```

`--detailed` adds the table descriptions to the listing. Use this first
when the user asks "do we have data on X?".

### `schema` — inspect one or more tables' columns

```bash
node /opt/psd-skills/psd-data/run.js schema --user <caller-email> \
  --table students

# multiple tables in one call:
node /opt/psd-skills/psd-data/run.js schema --user <caller-email> \
  --table '["students","enrollments"]'
```

### `permissions` — show the user's row-level filters on a table

```bash
node /opt/psd-skills/psd-data/run.js permissions --user <caller-email> \
  --table students
```

Use this when a query unexpectedly returns no rows — the user may not
have access to the rows they expect.

### `query` — run a SELECT query

```bash
node /opt/psd-skills/psd-data/run.js query --user <caller-email> \
  --reason "Headcount sanity check before report" \
  --sql "SELECT COUNT(*) FROM students WHERE active = true"
```

Optional flags:
- `--export` — return a 5-minute presigned S3 download URL for CSV (use
  this when the user asks for the data as a file). If you get a `url` field
  back in the result, paste it on its own line per rule 9.
- `--view-results` — include the result rows inline (default true; pass
  `--view-results false` for export-only).
- `--limit <N>` `--offset <N>` — paging.

`--reason` is **required** by the MCP server for audit. State the user's
intent in plain English; do not pad with fluff.

**Hard rules from the MCP server (do not try to bypass):**
- Only `SELECT` queries are accepted; DDL / DML are rejected
- Row-level security rewrites your query — do not write your own access
  filters; let the server do it
- Casts to `NUMERIC` / `DECIMAL` without precision are rejected

### Lessons

The MCP server has a persistent "lessons" store — cross-session knowledge
about the data ("this column is null for graduated students", "this table
joins on `student_id`, not `id`"). Use lessons when you learn something
non-obvious that future invocations should know.

**Save a lesson** (only after you've actually learned it):

```bash
node /opt/psd-skills/psd-data/run.js lesson-save --user <caller-email> \
  --lesson "When querying student enrollments, filter exit_date IS NULL for active students. Otherwise counts double on re-enrollees." \
  --tables '["students","enrollments"]' \
  --task "headcount queries" \
  --category "filter_behavior" \
  --significance 7
```

Categories: `data_quality`, `schema`, `query_pattern`, `domain_knowledge`,
`filter_behavior`. Significance is 1–10 (10 = critical correctness rule).

**Check for relevant lessons** before running a query you're unsure about:

```bash
node /opt/psd-skills/psd-data/run.js lesson-check --user <caller-email> \
  --task "headcount of active students" \
  --tables '["students"]'
```

**Rate a lesson** that came back from `lesson-check`:

```bash
node /opt/psd-skills/psd-data/run.js lesson-rate --user <caller-email> \
  --id 42 --rating helpful

node /opt/psd-skills/psd-data/run.js lesson-rate --user <caller-email> \
  --id 42 --rating unhelpful --feedback "The lesson was about a different table"
```

**Delete a lesson** you saved within the last 24 hours:

```bash
node /opt/psd-skills/psd-data/run.js lesson-delete --user <caller-email> \
  --uuid <uuid-from-save-response>
```

## Rules

1. **Pass the caller's email verbatim.** Do not substitute your own agent
   email. Row-level security depends on it.
2. **Always supply `--reason`** for `query`. Lying or padding will land in
   the audit log; the data team reviews these.
3. **No mutations.** The server rejects them; do not try.
4. **On `needs-auth`, paste the consent link on its own line.** Do not
   retry, do not improvise an alternative auth flow.
5. **On `forbidden`, surface the data-team contact pointer.** The skill
   already includes a helpful message — use it.

## Example end-to-end

User: "How many students were enrolled in PSD as of last Tuesday?"

```bash
# First, check what's known about this kind of query
node /opt/psd-skills/psd-data/run.js lesson-check --user hagelk@psd401.net \
  --task "active student headcount on a specific date" \
  --tables '["students","enrollments"]'

# Then inspect the schema
node /opt/psd-skills/psd-data/run.js schema --user hagelk@psd401.net \
  --table '["students","enrollments"]'

# Run the query
node /opt/psd-skills/psd-data/run.js query --user hagelk@psd401.net \
  --reason "Active enrollment count as of 2026-05-06 per user request" \
  --sql "SELECT COUNT(DISTINCT student_id) FROM enrollments
         WHERE enroll_date <= '2026-05-06'
           AND (exit_date IS NULL OR exit_date > '2026-05-06')"
```
