---
name: psd-freshservice
summary: Manage Freshservice tickets, approvals, and team summaries — uses each caller's own personal API key, stored per-user in Secrets Manager.
description: Operate against the PSD Freshservice instance (psd401.freshservice.com) with the caller's personal API key. On first invocation per user, the skill prompts the user to paste their Freshservice API key (Profile → API Key) and stores it via psd-credentials so future calls are silent. Supports listing/searching/getting/creating/updating tickets, adding notes, agent and workspace lookup, approval queues, and daily/weekly Technology workspace summaries.
allowed-tools: Bash(node:*)
---

# psd-freshservice

Each Freshservice user has their own API key (Profile → API Key). This skill uses the caller's key — *not* a shared service account — so all actions are attributed to the user in Freshservice and inherit their workspace permissions.

**Identity.** Every command requires `--user <caller-email>`. Pass the email verbatim from the `[caller: Name <email>]` header in the user turn. The skill resolves the API key from `psd-agent-creds/{env}/user/<email>/freshservice_api_key`.

## First-time setup (no key yet)

If the credential is missing, the skill exits `2` and prints a structured prompt:

```json
{
  "error": "freshservice_key_missing",
  "user": "...",
  "instructions": [
    "Open https://psd401.freshservice.com/agent/profile and copy your personal API key.",
    "Paste it back to me in chat — I will store it securely in Secrets Manager so I can reuse it next time.",
    "After you paste, I will retry the command via psd-credentials put."
  ],
  "storeCommand": { ... }
}
```

When you see `freshservice_key_missing`, ask the user to paste their key. After they paste, run:

```bash
node /home/node/.openclaw/skills/psd-credentials/put.js \
  --user <email> \
  --name freshservice_api_key \
  --value "<pasted-key>"
```

Then retry the original command. Never echo the key back. Never write it to a file. Never include it in subsequent responses.

## Tickets

```bash
# List tickets — filter: new_and_my_open | watching | spam | deleted
node list_tickets.js --user <email> [--options '{"workspace_id":2,"filter":"new_and_my_open","per_page":30}']

# Search via filter query — e.g. "responder_id:6000130414", "status:2 AND priority:3"
node search_tickets.js --user <email> --query 'status:2 AND priority:3' [--workspace-id 2]

# Get one ticket
node get_ticket.js --user <email> --id <ticket_id> [--include conversations,requester]

# Service-request ticket with form data + requester profile + conversations
node get_service_request.js --user <email> --id <ticket_id>

# Create
node create_ticket.js --user <email> \
  --data '{"subject":"...","description":"...","email":"requester@...","priority":2,"workspace_id":2}'

# Update — status 2 Open / 3 Pending / 4 Resolved / 5 Closed; priority 1-4
node update_ticket.js --user <email> --id <id> --data '{"status":4}'

# Add note (default private)
node add_note.js --user <email> --id <id> --data '{"body":"...","notify_emails":["a@b.com"]}'
```

## Agents and Workspaces

```bash
# Find an agent by email (defaults to the caller)
node get_agent.js --user <caller-email> [--email <agent-email>]

# List active agents, optionally filtered
node list_agents.js --user <email> [--query <name-substring>]

# Workspaces visible to the caller
node get_workspaces.js --user <email> [--id <workspace_id>]
```

Workspace IDs in PSD: 2 Technology (primary), 3 Employee Support Services, 4 Business Services, 5 Teaching & Learning, 6 Maintenance, 8 Investigations, 9 Transportation, 10 Safety & Security, 11 Communications, 13 Software Development.

## Approvals

```bash
# Pending approvals across tickets and changes (auto-resolves caller's agent ID)
node get_approvals.js --user <email> [--status requested|approved|rejected|cancelled]
```

Freshservice does not support approving via API. Surface the approval IDs and direct the user to either the email approval link or `https://psd401.freshservice.com/helpdesk/tickets/<id>`.

## Reports

```bash
# Daily — date may be 'today' (default), 'yesterday', a day name, 'last <day>', or YYYY-MM-DD
node get_daily_summary.js --user <email> [--date today] [--workspace-id 2]

# Weekly — Mon-Sun; weeks_ago 0 = this week (default)
node get_weekly_summary.js --user <email> [--weeks-ago 0] [--workspace-id 2]
```

Both summaries query closed (status 4) and resolved (status 5) tickets in the named workspace, then aggregate by agent and by category. Pacific time handling uses the container's `TZ=America/Los_Angeles` setting, which handles PST/PDT transitions automatically.

### Narrative style for summaries

When presenting summary output, write a 1-minute narrative that:

- Highlights the main story (outages, big pushes, incident clusters).
- Calls out specific people and what they handled.
- Notes concerning patterns (security alerts, repeated chromebooks, etc.).
- Converts UTC timestamps to Pacific time.
- Uses specific numbers and ticket counts.

## Status / Priority Codes

| Status | | | Priority | |
|---|---|---|---|---|
| 2 | Open | | 1 | Low |
| 3 | Pending | | 2 | Medium |
| 4 | Resolved | | 3 | High |
| 5 | Closed | | 4 | Urgent |

## Errors

- **`freshservice_key_missing`** (exit 2) — caller has not registered their API key. Prompt for it (see above).
- **`upstream_error`** — Freshservice returned non-2xx. Surface status and message; ask the user before retrying mutating operations.
- **`bad_args`** — required argument missing or malformed.
- **`agent_lookup_failed`** — could not resolve the caller's Freshservice agent ID via `/agents?email=`. Confirm the caller's email matches their Freshservice login.

## Security

- API keys are stored only in AWS Secrets Manager at `psd-agent-creds/{env}/user/<email>/freshservice_api_key`.
- The skill never echoes the key, never writes it to workspace files, and never includes it in tool output.
- Each user's key authenticates every Freshservice call — actions are attributed to that user, not a service account.
