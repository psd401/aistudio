---
name: psd-plaud
summary: Read the caller's own Plaud voice recordings (list, search, transcripts, AI summaries) via Plaud's MCP server, per-user OAuth.
description: Read the caller's Plaud voice recordings — list/search recordings and fetch transcripts and AI summaries. Use for Plaud, voice memos, recorded meetings, "my recordings/notes", transcript or summary of a recording.
allowed-tools: Bash(node:*)
---

# psd-plaud

Read the calling user's **own** Plaud recordings. Each user authorizes their own
Plaud account once (a chat link → browser consent); the skill then reads only
that caller's data. It talks to Plaud's hosted MCP server
(`https://mcp.plaud.ai/mcp`) with a per-user OAuth token stored in Secrets
Manager — never a shared account.

## Invoke

    node /opt/psd-skills/psd-plaud/run.js --user <caller-email> <subcommand> [flags]

`<caller-email>` is the email in the `[caller: Name <email>]` header of the turn.

| Subcommand | Purpose | Flags |
|---|---|---|
| `list` | List recent recordings | `--page` `--page-size` `--query` `--from` `--to` |
| `search` | List recordings matching a keyword | `--query <kw>` (required) |
| `file` | One recording's metadata + audio URL | `--id <id>` |
| `transcript` | Full transcript of a recording | `--id <id>` |
| `summary` | AI summary / action items / topics | `--id <id>` |
| `whoami` | The connected Plaud account | — |
| `tools` | Introspect the live MCP tool schema | — |

## Auth flow (chat → browser, one time per user)

- On first use (or a revoked token) the skill returns
  `{"status":"needs-auth","consent_chat_hyperlink":"<url|Connect your Plaud account>"}`
  and exits 10. **Paste `consent_chat_hyperlink` on its own line**, no markdown,
  then on a separate line ask the user to click it. Do not construct any URL
  yourself (psd-rules Rule 2/9). After they authorize, retry the command.

## Output contract

- **Success (exit 0):** stdout is the MCP tool result JSON. For `transcript`/
  `summary`, surface the text content to the user or use it to answer their
  question (e.g. summarize). Transcripts are the user's own recordings.
- **needs-auth (exit 10):** paste the consent link as above.
- **Errors:** exit 12 (MCP/upstream), 14 (rate-limited) — report the error;
  do not improvise around it.

## Privacy

Transcript/summary **content is redacted from AI Studio's logs and telemetry**
(the harness marks psd-plaud tool output as sensitive) but is still passed to
the model so you can summarize or answer questions about it. Keep it that way —
do not echo raw transcripts into any other logged surface.

## Notes

- Read-only. There is no create/delete/share path.
- Tool names/arg shapes follow Plaud's documented MCP tools; if a call fails on
  an argument, run `tools` to see the live schema.
