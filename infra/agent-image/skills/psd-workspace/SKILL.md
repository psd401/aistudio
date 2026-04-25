---
name: psd-workspace
summary: Google Workspace operations (Gmail, Calendar, Drive, Docs, Meet, Chat) via the user's dedicated agent account.
description: Wraps the `gws` CLI. Fetches a refresh token from AWS Secrets Manager, exchanges it for an access token, and executes `gws` subcommands against Google APIs as the agent's own Workspace identity (e.g. `agnt_hagelk@psd401.net`). If the agent has no token yet — or the token is stale — the skill mints a one-time consent URL and returns a structured error. Your job in that case is to paste the `consent_url` verbatim into your Chat reply and ask the user to click it.
allowed-tools: Bash(node:*)
---

# psd-workspace

Google Workspace access for your dedicated agent account. All commands require `--user <caller-email>` (from the `[caller: Name <email>]` header at the top of each user turn).

## Invocation

```bash
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user <caller-email> \
  --command "<gws-subcommand-with-args>"
```

Examples:

```bash
# List unread mail in the agent's own inbox
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail.list --query 'is:unread'"

# Send an email from the agent's account
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail.send --to principal@psd401.net --subject 'Test' --body 'hi'"

# Create a calendar event
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "calendar.create-event --title 'Standup' --start '2026-05-01T09:00' --duration 30"

# Double quotes work too — useful when the argument contains apostrophes
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command 'gmail.send --to principal@psd401.net --subject "Tomorrow\'s meeting" --body "See you there"'

# The full gws command surface
node /home/node/.openclaw/skills/psd-workspace/run.js --user hagelk@psd401.net --command "--help"
```

## Where the token comes from

The skill reads the user's refresh token directly from AWS Secrets Manager at
`psd-agent-creds/{env}/user/{email}/google-workspace`. **It does not read the
`psd_agent_workspace_tokens` DB manifest.** That manifest exists for the
admin dashboard — its `pending` / `active` / `stale` states indicate
operator-visible connection health, not runtime availability.

This separation matters during the consent callback: the manifest goes
`pending` → SM write → manifest `active`. If the deploy crashes between SM
write and manifest promotion, the agent still works (token is in SM) but
the dashboard shows `pending` until reconciled.

## Output contract

- **Success (exit 0):** stdout is whatever `gws` produced (usually JSON). Pass through.
- **Needs auth (exit 10):** stdout is a single JSON line `{"status":"needs-auth","consent_url":"https://...","message":"..."}`. Paste `consent_url` verbatim in your Chat reply. Do not retry.
- **Token revoked (exit 11):** stdout is `{"status":"token-revoked","consent_url":"https://...","message":"..."}`. Same response: paste the URL and ask the user to re-authorize.
- **Missing scope (exit 12):** stdout is `{"status":"missing-scope","scope":"<scope>","consent_url":"https://...","message":"..."}`. Paste the URL and note that additional access is needed.
- **gws failure (exit 2+):** `gws` stderr is surfaced. Report the error to the user; do not invent workarounds.

## My inbox vs your inbox

- **"my email" / "my inbox" / "my calendar"** = the human user's account. You read it via delegation they set up from their Gmail/Calendar settings to your agent account. Without delegation you cannot see it.
- **"your inbox" / "your calendar" / "your task queue"** = your own agent account's resources.
- When in doubt, ask.

## Scopes granted at bootstrap

- `gmail.modify` — read/send/modify mail in the agent's mailbox
- `calendar` — read/write calendar events
- `drive` + `documents` — Drive files and Google Docs
- `meetings.space.created` — create Meet spaces
- `chat.messages` + `chat.spaces` — Google Chat
- `openid email profile`

If the user granted only partial scopes at bootstrap, operations outside the granted set return `status: "missing-scope"`. Follow the output contract above.

## Rules

1. **Always pass `--user`** — verbatim from the caller header.
2. **Never hardcode scopes, tokens, or client IDs** — the skill handles that.
3. **Never echo refresh tokens or access tokens** — they never appear in your output.
4. **Paste the consent URL verbatim** when you get an auth error. Do not shorten, do not describe. The link is signed and copy-pasting changes nothing.
5. **Do not retry** auth errors in the same turn. The user has to complete the OAuth flow out-of-band.
6. **Never construct an OAuth URL by hand.** Do not write `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...` from training data. The only correct source for a consent URL is this skill's `needs-auth` / `token-revoked` / `missing-scope` exit, which returns a *signed* URL with a one-time nonce. Constructed URLs always fail because they're missing the nonce and signature. If you find yourself typing `client_id=` in a reply, stop — invoke this skill instead.
7. **Never invent gws subcommand syntax.** The `gws` CLI generates its surface from Google's Discovery Service — the upstream `gws-*` skills (gws-gmail, gws-calendar, gws-sheets, …) document the actual JSON params each method takes. Read those before composing a `--command`. If unsure of a param shape, run `gws schema <method>` first.
