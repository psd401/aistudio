---
name: psd-workspace
summary: Google Workspace operations (Gmail, Calendar, Drive, Docs, Meet, Chat) via the user's dedicated agent account.
description: Wraps the `gws` CLI. Fetches a refresh token from AWS Secrets Manager, exchanges it for an access token, and executes `gws` subcommands against Google APIs as the agent's own Workspace identity (e.g. `agnt_hagelk@psd401.net`). If the agent has no token yet — or the token is stale — the skill mints a one-time consent URL and returns a structured error. Your job in that case is to paste the `consent_url` verbatim into your Chat reply and ask the user to click it.
allowed-tools: Bash(node:*)
---

# psd-workspace

Google Workspace access for the user's data, gated by Phase 1 boundaries (#912). All commands require `--user <caller-email>` (from the `[caller: Name <email>]` header at the top of each user turn).

## Two OAuth slots — `--scope` flag

Phase 1 introduces two parallel OAuth identities per user. The `--scope` flag selects which:

- `--scope user` (**default**) — OAuth on the human user (e.g. `hagelk@psd401.net`). Narrow scopes: `gmail.readonly`, `gmail.compose`, `calendar`, `tasks`, `drive.file`. Use this for reading the user's mail, managing their tasks, writing to their calendar, creating new Drive files for them.
- `--scope agent` — OAuth on the agent identity (e.g. `agnt_hagelk@psd401.net`). Broad scopes. Use this for actions the agent takes *as itself* (the agent's own calendar, drafts owned by the agent, agent-owned Drive folder).

If you omit `--scope`, the skill defaults to `user`. Phase 1 work is overwhelmingly on user data.

## Invocation

```bash
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user <caller-email> \
  --command "<gws-subcommand-with-args>" \
  [--scope user|agent]
```

Examples:

```bash
# Read user's unread mail (Phase 1 default scope = user)
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail users messages list --params '{\"userId\":\"me\",\"q\":\"is:unread\",\"maxResults\":20}'"

# Create a draft on the user's account (lands in their Drafts folder, marker
# is auto-appended to the body — they review and send themselves)
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail +draft --to principal@psd401.net --subject 'Follow up' --body 'Hi Bill,...'"

# Create a task on the user's tasks (in the 'Your Agent' tasklist)
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "tasks tasks insert --params '{\"tasklist\":\"@default\"}' --json '{\"title\":\"Review budget\",\"due\":\"2026-04-29T17:00:00Z\"}'"

# Create a calendar event on the user's calendar (marker auto-prepended to description)
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "calendar events insert --params '{\"calendarId\":\"primary\"}' --json '{\"summary\":\"Standup\",\"start\":{\"dateTime\":\"2026-05-01T09:00:00-07:00\"},\"end\":{\"dateTime\":\"2026-05-01T09:30:00-07:00\"}}'"

# Schedule something on the AGENT's own calendar (e.g. internal reminders)
node /home/node/.openclaw/skills/psd-workspace/run.js \
  --user hagelk@psd401.net --scope agent \
  --command "calendar events insert --params '{\"calendarId\":\"primary\"}' --json '{\"summary\":\"agent self-reminder\"}'"

# The full gws command surface
node /home/node/.openclaw/skills/psd-workspace/run.js --user hagelk@psd401.net --command "--help"
```

## Phase 1 boundaries (hard gates — refused at the skill layer)

These cannot be bypassed by phrasing. The skill returns exit code 13 with `status: phase1-forbidden`:

- **No sending mail.** `gmail.users.messages.send`, `gmail.users.drafts.send`, `+send`, `+reply`, `+reply-all`, `+forward` — all blocked. Drafts only.
- **No deletes.** Mail (delete/trash/batchDelete), events, calendars, Drive files, drive trash, tasks, tasklists.
- **No permission changes.** `drive.permissions.create/update/delete`.

If a user explicitly asks the agent to send something, post the draft + a clear "I drafted it; reply 'send' if it's right" in Chat instead. The user clicks send themselves.

## Marker conventions (auto-injected on writes)

The skill silently adds these to every write:

- **Calendar event create/update/patch** → description prepended with `🤖 Created by your agent on YYYY-MM-DD.`
- **Drive file create** → filename prefixed `[Agent] `, `appProperties.psdAgentCreated=true`
- **Gmail draft create** (when body is in the `.message.body` field) → footer `— Drafted by your agent. Review before sending.`

You don't need to remember to add markers — the skill does it. **Do not** strip them or instruct the user to strip them; they're the audit substrate.

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
- **Needs auth (exit 10):** stdout is a single JSON line `{"status":"needs-auth","consent_url":"https://...","kind":"user_account|agent_account","message":"..."}`. Paste `consent_url` verbatim in your Chat reply. Do not retry. The `kind` field tells you which slot needs consent — surface that to the user (e.g. "I need permission to read your inbox" vs "I need to connect my agent account").
- **Token revoked (exit 11):** stdout is `{"status":"token-revoked","consent_url":"https://...","kind":"...","message":"..."}`. Same response: paste the URL and ask the user to re-authorize.
- **Missing scope (exit 12):** stdout is `{"status":"missing-scope","scope":"<scope>","consent_url":"https://...","message":"..."}`. Paste the URL and note that additional access is needed.
- **Phase 1 forbidden (exit 13):** stdout is `{"status":"phase1-forbidden","reason":"<short>","message":"<longer>"}`. The user asked you to do something Phase 1 disallows (send mail, delete, etc.). Tell them what you can do instead — usually "I'll draft it; reply 'send' if it's right." Do **not** retry with a workaround.
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
