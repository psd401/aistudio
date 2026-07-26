---
name: psd-workspace
summary: Google Workspace operations (Gmail, Calendar, Drive, Docs, Meet, Chat) via the user's dedicated agent account.
description: Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides, Meet, Chat) as the user's agent account. Use for reading or writing email, calendar events, files, or any Workspace data.
allowed-tools: Bash(node:*)
---

# psd-workspace

Google Workspace access for the user's data, gated by Phase 1 boundaries (#912). All commands require `--user <caller-email>` (from the `[caller: Name <email>]` header at the top of each user turn).

## Two OAuth slots — `--scope` flag

Phase 1 introduces two parallel OAuth identities per user. The `--scope` flag selects which:

- `--scope user` (**default**) — OAuth on the human user (e.g. `hagelk@psd401.net`). Scopes: `gmail.modify` (read + draft + send + archive/label, no permanent delete), `calendar`, `tasks`, `drive.file`, `drive.readonly`, `drive.metadata`. Use this for reading the user's mail, managing their tasks, writing to their calendar, and **reading and organizing their Drive** (see below). **NEVER for creating Drive files/Docs/Sheets/Slides** — a file created on this slot is OWNED BY THE USER, which is impersonation (hard-blocked at the skill layer, 2026-07-07). Folders are the single exception, because a folder has no content to author. Every *document* you produce is created with `--scope agent` and shared explicitly. Sending is gated by behavioral rules — always confirm before actually sending.
- `--scope agent` — the agent identity (e.g. `agnt_hagelk@psd401.net`). Broad scopes. Use this for actions the agent takes *as itself* (the agent's own calendar, drafts owned by the agent, agent-owned Drive folder). **There is no consent step for this slot** (as of #1232): the skill mints a short-lived access token automatically from the token broker. If your agent account hasn't been created yet you'll get `status: "account-provisioning"` (exit 14) — it's being set up automatically; just tell the user to retry in ~30 minutes. **Never** show a consent link for the agent slot.

If you omit `--scope`, the skill defaults to `user`. Phase 1 work is overwhelmingly on user data.

## Reading and organizing the user's Drive (`--scope user`)

Since 2026-07-25 (#1305) the user slot holds `drive.readonly` +
`drive.metadata` in addition to `drive.file`. On that slot you **can**:

| Do this | How |
|---|---|
| List / search anything the user can see | `drive files list --params '{"q":"…"}'` |
| Read or export a file | `drive files get` / `drive files export` |
| Rename a file | `drive files update --params '{"fileId":"…"}' --json '{"name":"New name"}'` |
| Move a file between folders | `drive files update --params '{"fileId":"…","addParents":"<new>","removeParents":"<old>"}' --json '{"name":"…"}'` |
| Star / describe / recolour | `drive files update … --json '{"starred":true}'` |
| **Create a folder** | `drive files create --json '{"name":"Budget 2026","mimeType":"application/vnd.google-apps.folder"}'` |

and you **cannot** — each refuses with a plain-language reason:

| Not this | Blocked by |
|---|---|
| Create a doc/sheet/deck/file in the user's Drive | the skill gate (impersonation ban, 2026-07-07) |
| Copy a file into the user's Drive | the skill gate — the copy would be owned by the user |
| Change any file's **content** | **Google** — no granted scope permits a content write |
| Trash or untrash a file (any `trashed` field) | the skill gate, on both slots — judged on the **parsed** payload, so a JSON key escape does not get around it |
| Permanently delete, or empty trash | **Google** — needs `drive`/`drive.file` on that file, which you do not have for anything you did not create |

Note the asymmetry: content edits and permanent deletion are impossible at the
**Google** layer, not merely refused by our regex. There is no phrasing that
gets around them.

Folders you create are exempt from the `[Agent] ` filename prefix — the user
asked for "Budget 2026", so that is what they get. The invisible
`appProperties.psdAgentCreated` marker is still applied.

### "One more permission" — exit 15

Users pick the new scopes up **lazily**, on their next consent click. A refresh
token issued before 2026-07-25 still carries only the old scopes, so a Drive
read or metadata update on that token exits **15** with
`status: "scope-upgrade-required"` and a `consent_chat_hyperlink`. Handle it
exactly like `needs-auth`: paste the hyperlink on its own line, then on a
separate line say *"I need one more permission to read your Drive — click the
link to grant it."* Do not retry until the user confirms. Everything the slot
could already do (mail, calendar, tasks, folder creation) keeps working on the
old token with no prompt.

### If a read still 404s

With `drive.readonly` a 404 now means the **user** genuinely cannot see that
file — not a scope gap. Retry with `--scope agent` (your agent identity is
`agnt_<caller-uniqname>@psd401.net`; for caller `hagelk@psd401.net` that is
`agnt_hagelk@psd401.net`), which can read anything shared with it. If that
also 404s, ask the user to **share it with your agent account** — Reader
access is enough.

**Never** tell the user to share the file with their **own** address
(`hagelk@psd401.net`): they already own it, so that guidance sends them in
circles. Name the **agent** account (`agnt_…`) every time. Do **not** describe
a 404 as "the file doesn't exist" or "you need to share it with yourself."

Chat message attachments arrive to you as an `[attachments: …]` header at the
top of the turn. A Drive chip / Drive-file attachment carries a `driveFileId` —
read it with the steps above. A file **uploaded directly in Chat**
(`source="chat-upload"`) is downloaded into your workspace for you: the header
carries `path="/home/node/.openclaw/attachments/…"` — read that file directly
with your file tools; no Drive access is involved. If the header instead marks
the upload `download failed`, the fetch didn't work this time — tell the user
and ask them to re-attach the file (or share it via Drive as a fallback).

## Invocation

```bash
node /opt/psd-skills/psd-workspace/run.js \
  --user <caller-email> \
  --command "<gws-subcommand-with-args>" \
  [--scope user|agent]
```

Examples:

```bash
# Read user's unread mail (Phase 1 default scope = user)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail users messages list --params '{\"userId\":\"me\",\"q\":\"is:unread\",\"maxResults\":20}'"

# Create a draft on the user's account (lands in their Drafts folder, marker
# is auto-appended to the body — they review and send themselves)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail +draft --to principal@psd401.net --subject 'Follow up' --body 'Hi Bill,...'"

# Create a task on the user's tasks (in the 'Your Agent' tasklist)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "tasks tasks insert --params '{\"tasklist\":\"@default\"}' --json '{\"title\":\"Review budget\",\"due\":\"2026-04-29T17:00:00Z\"}'"

# Create a calendar event on the user's calendar (marker auto-prepended to description)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "calendar events insert --params '{\"calendarId\":\"primary\"}' --json '{\"summary\":\"Standup\",\"start\":{\"dateTime\":\"2026-05-01T09:00:00-07:00\"},\"end\":{\"dateTime\":\"2026-05-01T09:30:00-07:00\"}}'"

# Schedule something on the AGENT's own calendar (e.g. internal reminders)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net --scope agent \
  --command "calendar events insert --params '{\"calendarId\":\"primary\"}' --json '{\"summary\":\"agent self-reminder\"}'"

# The full gws command surface
node /opt/psd-skills/psd-workspace/run.js --user hagelk@psd401.net --command "--help"
```

## Passing real text: `--json-file` / `--body-file` (REQUIRED for content writes)

The `--command` tokenizer has **no escape syntax**: an apostrophe inside a
single-quoted value, mixed quotes, or a newline breaks tokenization, and there
is no way to fix it with more quoting. **Never inline document/email/event
body text in `--json` or `--body`.** Instead, write the payload to a file
first and reference it:

```bash
# 1. Write the payload to a file (any quotes/newlines/emoji are fine here)
cat > /tmp/doc-payload.json <<'PAYLOAD'
{"requests":[{"insertText":{"location":{"index":1},"text":"It's fine to use \"both\" quote kinds.\n\nNew paragraphs too."}}]}
PAYLOAD

# 2. Reference it with --json-file (replaces --json)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "docs documents batchUpdate --params '{\"documentId\":\"<id>\"}' --json-file /tmp/doc-payload.json"

# Plain-text bodies (e.g. +draft) use --body-file (replaces --body)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail +draft --to bill@psd401.net --subject 'Follow up' --body-file /tmp/draft-body.txt"

# Chat message text (+send) uses --text-file (replaces --text)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net --scope agent \
  --command "chat +send --space spaces/XXXX --text-file /tmp/chatmsg.txt"
```

Rules: the path must be absolute; use the file form OR the inline flag, never
both (`--json`/`--json-file`, `--body`/`--body-file`, `--text`/`--text-file`);
one of each flag per command. The file content is handed to gws as exactly one
argv token — quoting rules never apply to it. Phase 1 gates and marker
injection still see the real payload (they run against the resolved content),
so this is a transport mechanism, not a bypass: forbidden operations are still
refused, and file-based payloads still get audit markers.

Use inline `--json` only for short, quote-free payloads you compose yourself
(IDs, dates, enum values). Anything containing prose goes through a file.

## Writing Google Docs: NATIVE formatting, never markdown

Google Docs does not render markdown — `# Heading`, `**bold**`, and `- bullet`
pasted as text show up literally and read as broken. When writing doc content
via `docs documents batchUpdate`:

- Insert plain text with `insertText` (no markdown syntax in the text).
- Make headings with `updateParagraphStyle` +
  `paragraphStyle.namedStyleType: "HEADING_1"` (…`HEADING_6`) over the
  heading's range.
- Make bullet/numbered lists with `createParagraphBullets`
  (`bulletPreset: "BULLET_DISC_CIRCLE_SQUARE"` or
  `"NUMBERED_DECIMAL_ALPHA_ROMAN"`) over the paragraphs' range.
- Bold/italic with `updateTextStyle` (`textStyle.bold: true`, `italic`) +
  `fields`.

Batch ALL requests for a section into ONE `batchUpdate` call (one `--json-file`
payload with a `requests` array) — one call per doc, not one call per
formatting operation. Compose the payload in a file and pass it with
`--json-file` (see above); index math is easiest when you insert text first
and style ranges immediately after, back-to-front.

## Phase 1 boundaries (hard gates — refused at the skill layer)

These cannot be bypassed by phrasing. The skill returns exit code 13 with `status: phase1-forbidden`:

- **No sending mail.** `gmail.users.messages.send`, `gmail.users.drafts.send`, `+send`, `+reply`, `+reply-all`, `+forward` — all blocked. Drafts only.
- **No deletes.** Mail (delete/trash/batchDelete), events, calendars, Drive files, drive trash, tasks, tasklists.
- **No permission changes.** `drive.permissions.create/update/delete` (except the explicit in-district shapes below).
- **No file creation as the user.** `drive files create/copy`, `docs documents create`, `sheets spreadsheets create`, `slides presentations create` on `--scope user` are hard-blocked — a file created there is owned by the user's account (impersonation; no attribution trail). Create with `--scope agent`, then share explicitly. **One exception, added 2026-07-25 (#1305):** `drive files create` with `mimeType` exactly `application/vnd.google-apps.folder` is allowed, because a folder carries no content and creating one is organizing, not authoring. The mimeType is matched exactly — a shortcut, a Doc, or a lookalike mimeType still refuses — and any media/upload flag alongside it refuses too. Nothing else gets through, and no phrasing changes that.
- **User-slot `drive files update` is metadata-only.** Rename, move, star, describe and recolour are allowed; anything else — an unrecognised field, a media/upload flag, or `{"trashed":true}` — refuses the whole call. The allowlist is all-or-nothing: one unknown key poisons the payload.

**Exception — explicit in-district shares of YOUR OWN files.** `drive.permissions.create` is permitted only on files the agent owns (`--scope agent`), only as `create` (never update/delete), and only in these explicit shapes:

- **Named person in the district:** `type: "user"`, `role: "reader"`, `"commenter"`, or `"writer"`, `emailAddress` ending `@psd401.net` — the caller or any district colleague. Writer is for explicitly named individuals only (e.g. each member of a team space, enumerated by name) — when a group needs to edit, grant each person, never the domain.
- **Whole district, read-only:** `type: "domain"`, `domain: "psd401.net"`, `role: "reader"` — use when a doc's link is going into a shared Chat space so every member can open it.

Never allowed: `type: "anyone"` or `"group"`, external addresses/domains, domain-wide `writer`, `owner` transfer, or any permission change on user-owned files.

Examples:

```bash
# Hand an artifact back to the caller
gws drive.permissions.create --scope agent --user hagelk@psd401.net \
  --json '{"fileId":"<id>","type":"user","role":"reader","emailAddress":"hagelk@psd401.net"}'

# Make a doc readable district-wide before posting its link in a Chat space
gws drive.permissions.create --scope agent --user hagelk@psd401.net \
  --json '{"fileId":"<id>","type":"domain","role":"reader","domain":"psd401.net"}'
```

When you post a doc link into a shared Chat space, share it district-wide (domain/reader) FIRST — otherwise members hit "request access". Anything outside these shapes is still blocked.

If a user explicitly asks the agent to send something, post the draft + a clear "I drafted it; reply 'send' if it's right" in Chat instead. The user clicks send themselves.

## Marker conventions (auto-injected on writes)

The skill silently adds these to every write:

- **Calendar event create/update/patch** → description prepended with `🤖 Created by your agent on YYYY-MM-DD.`
- **Drive file create** → filename prefixed `[Agent] `, `appProperties.psdAgentCreated=true`
- **Gmail draft create** (when body is in the `.message.body` field) → footer `— Drafted by your agent. Review before sending.`

You don't need to remember to add markers — the skill does it. **Do not** strip them or instruct the user to strip them; they're the audit substrate.

## Where the token comes from

- **User slot (`--scope user`):** the skill reads the user's refresh token
  directly from AWS Secrets Manager at
  `psd-agent-creds/{env}/user/{email}/google-workspace-user` and exchanges it
  for an access token. First-time / revoked → consent flow (exit 10/11).
- **Agent slot (`--scope agent`):** as of #1232 there is **no refresh token and
  no consent**. The skill POSTs to the app's DWD token broker
  (`/api/agent/workspace-token`) which mints a short-lived access token for
  `agnt_<you>@psd401.net` via domain-wide delegation. If the agnt_ account
  doesn't exist yet the broker returns "not provisioned" and the skill emits
  exit 14 (the router creates the account automatically).

Neither slot reads the `psd_agent_workspace_tokens` DB manifest at runtime —
that manifest exists for the admin dashboard (operator-visible connection
health), not runtime availability.

## Output contract

- **Success (exit 0):** stdout is whatever `gws` produced (usually JSON). Pass through.
- **Needs auth (exit 10):** stdout is a single JSON line `{"status":"needs-auth","consent_url":"...","consent_chat_hyperlink":"<url|label>","kind":"user_account|agent_account","message":"..."}`. **Paste `consent_chat_hyperlink` exactly, on a line by itself** — no `**`, no `[]()`, no parentheses, no period, no surrounding text on the same line. Then on a *separate* line explain what it is (use the `kind` field — "I need permission to read your inbox" vs "I need to connect my agent account"). Do not retry. **Why this matters:** wrapping the URL in markdown breaks Google Chat's URL parsing and corrupts the JWT signature in transit (incident 2026-04-27). The `<url|label>` form is Chat's native hyperlink syntax — Chat renders it as a clickable link without ambiguity.
- **Token revoked (exit 11):** stdout is `{"status":"token-revoked","consent_url":"...","consent_chat_hyperlink":"<url|label>","kind":"...","message":"..."}`. Same rule: paste `consent_chat_hyperlink` on its own line, no surrounding markdown, then ask the user to re-authorize on a separate line.
- **Transport error (exit 12):** `gws`-style stderr message — the skill couldn't reach the token broker or Google (network/5xx). This is transient: tell the user Workspace access is temporarily unavailable and to try again shortly. Do not paste a consent link (there isn't one).
- **Phase 1 forbidden (exit 13):** stdout is `{"status":"phase1-forbidden","reason":"<short>","message":"<longer>"}`. The user asked you to do something Phase 1 disallows (send mail, delete, etc.). Tell them what you can do instead — usually "I'll draft it; reply 'send' if it's right." Do **not** retry with a workaround.
- **Account provisioning (exit 14):** stdout is `{"status":"account-provisioning","kind":"agent_account","message":"..."}`. Only the **agent slot** produces this: your `agnt_` Workspace account is being created automatically. Tell the user their agent account is being set up and to try again in about 30 minutes. There is **NOTHING to click** — do not show a consent link, do not retry in the same turn.
- **Scope upgrade required (exit 15):** stdout is `{"status":"scope-upgrade-required","consent_url":"...","consent_chat_hyperlink":"<url|label>","kind":"user_account","missing_scopes":[...],"message":"..."}`. Only the **user slot** produces this, and only for the Drive read/organize operations added in #1305: the user authorized you *before* that feature existed, so their stored token predates the scope. Same rule as exits 10/11 — paste `consent_chat_hyperlink` on its own line, no surrounding markdown, then on a separate line say *"I need one more permission to read your Drive — click the link to grant it."* Frame it as **one more permission**, not as "you never authorized me" (exit 10) or "your access was revoked" (exit 11). Do not retry until the user confirms they clicked it.
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
