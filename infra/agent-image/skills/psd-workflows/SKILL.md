---
name: psd-workflows
summary: Discover and conduct PSD gateway workflows conversationally, including evaluations, requests, and timesheets, with verified caller binding and explicit confirmation before submission.
description: Use the live PSD Agent Gateway roster to conduct a supported workflow in chat. Discover tools, load the selected family's schema, follow its categories and validation guidance, confirm a complete summary, submit only after explicit approval, and return any signing or completion link.
allowed-tools: Bash(node:*)
---

# psd-workflows

Conduct workflows exposed by the **PSD Agent Gateway**. The gateway roster is
dynamic: do not assume a workflow family, tool name, argument shape, category,
or rating scale from memory. The gateway is the source of truth for discovery,
schema, validation, directory relationships, and final workflow processing.

## Required flow

### 1. Discover the live roster

```bash
node /opt/psd-skills/psd-workflows/run.js list
```

The result groups the current MCP `tools/list` roster into families. Choose only
a tool that appears in this response.

To inspect one tool in full:

```bash
node /opt/psd-skills/psd-workflows/run.js describe --tool <tool-name>
```

Read its description and `inputSchema`, including required fields and field
descriptions. A caller identity field is marked `[caller-bound]`; the web broker
always replaces that field with the verified signed owner.

### 2. Load the workflow family's schema

Most workflow families expose a `get_*_schema` tool. Call the schema tool before
starting the conversation:

```bash
node /opt/psd-skills/psd-workflows/run.js call \
  --tool <get-family-schema-tool> \
  --user <caller-email>
```

Drive the conversation from what the schema returns: categories, allowed
values, rubric text, recommended order, required people or records, and any
family-specific instructions. Ask one clear question at a time. Never invent a
category, scale, person, relationship, or validation rule.

### 3. Gather and validate inputs

Use any roster tools the schema directs you to use. Always pass `--user`
verbatim from the `[caller: Name <email>]` header:

```bash
node /opt/psd-skills/psd-workflows/run.js call \
  --tool <tool-name> \
  --user <caller-email> \
  --json '{"field":"value"}'
```

Names and email addresses typed in chat are only candidate inputs. Present the
people and relationships returned by the gateway; never claim that a person is
eligible, supervised, or authorized unless the gateway confirms it.

### 4. Confirm a complete summary

Before calling **any** `submit_*` tool, show the user a complete summary of
every collected field and get an explicit yes. A vague acknowledgement is not
confirmation. If anything changes after confirmation, show the revised summary
and confirm again.

### 5. Submit and return the result

Put payloads containing prose in a JSON file so quotes and newlines are
preserved:

```bash
node /opt/psd-skills/psd-workflows/run.js call \
  --tool <submit-tool-name> \
  --user <caller-email> \
  --json-file /tmp/workflow-payload.json
```

The broker derives the verified caller from the signed invocation context and
overrides every `[caller-bound]` argument. Any `submit_*` tool missing that
marker is rejected; do not work around this failure. Relay actionable gateway
validation errors and correct the input rather than retrying blindly.

If the result includes a signing or completion URL, return it verbatim on its
own line and explain the next step using the workflow's returned instructions.
Never fabricate a link or claim completion before the gateway reports it.

## Invariants

1. **Always pass `--user` verbatim from the caller header.** Do not substitute a
   typed name, email, remembered identity, or agent-selected owner.
2. **Never trust typed names or relationships.** The gateway re-derives
   authoritative people and eligibility; present only what it returns.
3. **Get explicit confirmation before every `submit_*` call.** Submission can
   create an envelope, request, record, or other consequential workflow state.
4. **Use `--json-file` for prose.** Inline JSON is for small payloads without
   quotes or newlines.
5. **Discover first.** Tool names, schemas, rating scales, and workflow families
   belong to the gateway and can change without an AI Studio release.

## Output contract

- **exit 0** — stdout is JSON containing the grouped roster, a tool
  description, or the tool result.
- **exit 2 (`bad-args`)** — the command, `--user`, tool name, or JSON payload is
  malformed. Fix the invocation. Legacy `schema`, `list-employees`, and
  `submit` commands intentionally return this usage error.
- **exit 11 (`not-configured`)** — the gateway secret is absent or incomplete.
  Tell the user the PSD workflow gateway is not configured and contact IT.
- **exit 12 (`transport-error`)** — the broker or gateway could not be reached
  or timed out. Tell the user it is temporarily unavailable.
- **exit 13 (`gateway-error`)** — discovery or the selected tool was rejected.
  Surface the returned message/data and correct actionable inputs. Never bypass
  a missing `[caller-bound]` marker.
