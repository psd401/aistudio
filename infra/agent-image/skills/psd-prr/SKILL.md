---
name: psd-prr
summary: Track the caller's PSD Public Records (PRR) work — requests, overdue items, collection tasks, exemptions, audit log — and draft clarification letters, task notes, and exemption citations, via PRR's MCP server with the caller's own personal token.
description: Read and track PSD Public Records requests (PRR) — list/get requests, overdue requests, collection tasks, record systems, exemptions, audit log, capabilities — and create drafts/proposals (clarification letter, collection-task notes, exemption citations) that a human approves in PRR. Use for public records, PRR, records requests, overdue records requests, daily PRR check.
allowed-tools: Bash(node:*)
---

# psd-prr

Work with the PSD Public Records system (https://prr.psd401.net) as the
calling staff member. Each person connects **their own** PRR personal access
token once; PRR then applies that person's PRR role server-side. The token is
held by AI Studio and never reaches you.

## Invoke

    node /opt/psd-skills/psd-prr/run.js tools
    node /opt/psd-skills/psd-prr/run.js call <tool> [--args '<json object>']

Identity comes from the signed invocation. Never pass `--user` or another
identity flag. If you are unsure of a tool's arguments, run `tools` first and
read its `inputSchema`; do not guess argument names.

| Tool | Kind | Use |
|---|---|---|
| `psd_prr_requests_list` | read | List requests |
| `psd_prr_request_get` | read | One request's detail |
| `psd_prr_overdue_requests_list` | read | Overdue requests (daily check) |
| `psd_prr_collection_tasks_list` | read | Collection tasks |
| `psd_prr_record_systems_list` | read | Record systems |
| `psd_prr_exemptions_list` | read | Exemptions |
| `psd_prr_audit_log_search` | read | Audit log search |
| `psd_prr_capabilities_list` | read | What this user's PRR role can do |
| `psd_prr_clarification_letter_draft` | draft | Draft a clarification letter |
| `psd_prr_collection_task_notes_propose` | proposal | Propose collection-task notes |
| `psd_prr_exemption_citations_suggest` | proposal | Suggest exemption citations |

## Reading results correctly

- **Overdue count:** report `total` from `psd_prr_overdue_requests_list`, not
  `count`. `count` is only the rows on this page.
- **`scan_complete: false`** means PRR stopped before scanning everything, so
  `total` is a floor. Say "at least N overdue", never "N overdue".
- **Drafts are not sent.** The three draft/proposal tools only create a draft
  or proposal inside PRR. Nothing reaches a requester. A human reviews and
  approves it in the PRR staff UI. Never tell the user a letter was sent or a
  citation was applied.
- PRR enforces roles and human-only hand-offs. If a call returns `forbidden`,
  report that their PRR role does not allow it; do not retry another way.

## Connecting (first use, or when the token expires)

PRR personal access tokens last at most 90 days. When the token is missing,
expired, or revoked, the command exits 10 with
`{"status":"needs-auth","code":"prr_token_missing"|"prr_token_rejected","url":...}`.

1. Tell the user to create a personal access token at
   https://prr.psd401.net/agent-access (it is shown once).
2. Send `url` on a line by itself — no markdown, no parentheses, no trailing
   period. They paste the token into that page. It works once and expires in
   15 minutes. If `url` is null, ask them to reply when ready and rerun the
   command to get a fresh link.
3. After they confirm it is saved, retry the original request.

Never ask the user to paste the token into chat, and never store a pasted
token with `psd-credentials put.js` (`--value` copies it into your tool-call
record). If they paste one anyway, tell them to revoke it at
https://prr.psd401.net/agent-access and create a new one.

In a **scheduled** run, include the step 1 instruction and the `url` in your
reply so the owner can reconnect, then stop; do not retry.

## Exit codes

0 ok (stdout is the MCP tool result JSON) · 1 usage · 10 needs-auth ·
11 forbidden · 12 MCP/upstream error (report it; do not improvise) ·
14 rate-limited.
