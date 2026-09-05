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

### Reading a Drive file's BYTES (PDF, .docx, .pptx, images)

`drive files get --params '{"fileId":"…","alt":"media"}'` downloads the file in
the trusted broker. The JSON you get back describes it — `{bytes, mimeType,
saved_file}` — and now also carries a `media` object telling you where the bytes
actually are:

```json
{"media": {"workspacePath": "downloads/download.pdf",
           "downloadUrl": "https://…",
           "requiredHeaders": {"Range": "bytes=0-481919"},
           "bytes": 481920, "contentType": "application/pdf"}}
```

- **`media.workspacePath`** — the file inside YOUR private workspace. It is not
  public: nothing here is ever written to the public `public-images/` prefix,
  because a board agenda or IEP form must not become readable by anyone holding
  a URL.
- **`media.downloadUrl`** — a short-lived (about 2 minutes) presigned link to
  the same object, so you can use it in THIS turn rather than waiting for the
  next workspace sync. Treat it as a credential: never paste it into chat or
  into a document.
- **`media.requiredHeaders` is not optional.** The URL is signed for a bounded
  request with `Range` in the signature, so a plain fetch fails on a
  signature/range mismatch. Send the header exactly as given.

To get text out of a PDF, hand the local copy to pdf-to-markdown:

```bash
node /opt/psd-skills/psd-workspace/run.js --user <caller> \
  --command "drive files get --params '{\"fileId\":\"<id>\",\"alt\":\"media\"}'"
# then fetch it WITH the required Range header, and convert the local copy:
curl -fsS -H "Range: $(…media.requiredHeaders.Range…)" "$(…media.downloadUrl…)" \
  -o /home/node/.openclaw/downloads/download.pdf
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-pdf-to-markdown/scripts/convert.py \
  --path /home/node/.openclaw/downloads/download.pdf
```

A download replaces the previous one of the SAME type; a different type lands
beside it (`download.pdf` and `download.png` can coexist). Process a file before
fetching the next of that type, and use `media.workspacePath` rather than
assuming a name. If `mediaError` is present the bytes could not be saved — say so and stop;
do not try to re-download by another route.

**Do not pass `-o`/`--output`.** It is refused by design (the broker will not
write response data to a caller-named path), and it is not the way to get the
file — `media` is.

## Invocation

### `--params` and `--json` are not interchangeable

Reading this section is a precondition for the first Workspace invocation in
each user turn. Do not make a speculative call from memory and correct it
afterward: the first request must use the documented flags.

Use `--params` for path and query parameters defined by the Google method
(IDs, search queries, page sizes). Use `--json` only for a request body on a
method that accepts one. Read/list methods such as
`gmail users messages list` take `--params`; never replace it with `--json`.
For a generic unread-mail listing when the caller supplies no different filter
or page size, preserve this exact default command shape:

```bash
gmail users messages list --params '{"userId":"me","q":"is:unread","maxResults":20}'
```

When the caller supplies a query, sender, other filter, or page size, preserve
those requested values inside `--params`; do not overwrite them with the
defaults above.

After a successful read/list call that the user asked only to summarize now,
return the requested fields immediately. Do not read or write memory, and do
not call an unrelated tool, before the final answer.

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
#
# CREATING DRAFTS IS SUPPORTED. Use exactly this form:
#
#   ✅ --command "gmail +draft --to … --subject … --body …"
#      Optional: --cc, --bcc, --html (body is HTML), or --body-file <abs-path>
#      in place of --body.
#
# `+draft` is a PSD helper, not a gws one: the trusted broker expands it into
# `gmail users drafts create` and builds the RFC 5322 message for you. Do not
# hand-build a MIME/base64 payload — that is the broker's job, and Rule 9 says
# not to replicate it. If you ever see "unrecognized subcommand +draft", the
# expansion did not run: report it and stop rather than working around it.
#
#   ❌ --command "gws +draft …"   `gws` is implied inside --command; naming it
#                                 makes `gws` the subcommand.
#   ❌ bare `gws …` as a shell command — the image's gws is a wrapper that
#      refuses direct calls. Always go through run.js.
#   ❌ --command "gmail +send --draft"  `+send` is Phase-1 forbidden whatever
#      flags follow, and no gws helper has a --draft flag. `+draft` is a
#      different verb and is not blocked.
#
# History, so nobody re-derives it: gws itself has NO draft verb — its gmail
# helpers are +send, +triage, +reply, +reply-all, +forward, +read, +watch, and
# none takes --draft. Before 2026-08-13 this line documented `gmail +draft`
# anyway, so drafting worked only for an agent that happened to use the
# canonical `gmail users drafts create` instead, and failed for everyone who
# followed this file (agent_failures 1112, 1953, 5187, 6078). The broker-side
# expansion is what makes the documented command real.
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

**Write the payload file with the `write` tool, not a shell heredoc.** `write`
takes the content as a parameter, so quotes, newlines and emoji never touch the
shell. A `cat <<'PAYLOAD'` heredoc has to survive `exec`'s quoting, and an
unterminated one leaves the shell sitting at a `>` continuation prompt with the
call never issued — observed 2026-08-06, where a Slides build was abandoned
after repeated attempts to generate the payload through `python3` + heredoc and
the batchUpdate was never sent at all.

```bash
# 1. write  →  /tmp/doc-payload.json
#    {"requests":[{"insertText":{"location":{"index":1},
#     "text":"It's fine to use \"both\" quote kinds.\n\nNew paragraphs too."}}]}
#    (use the `write` TOOL for this step — do not cat/heredoc it)

# 2. Reference it with --json-file (replaces --json)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "docs documents batchUpdate --params '{\"documentId\":\"<id>\"}' --json-file /tmp/doc-payload.json"

# Slides and Sheets take the SAME shape — the rule is not Docs-specific.
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "slides presentations batchUpdate --params '{\"presentationId\":\"<id>\"}' --json-file /tmp/slides-payload.json"

node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "sheets spreadsheets batchUpdate --params '{\"spreadsheetId\":\"<id>\"}' --json-file /tmp/sheet-payload.json"

# Plain-text bodies (e.g. +draft) use --body-file (replaces --body)
node /opt/psd-skills/psd-workspace/run.js \
  --user hagelk@psd401.net \
  --command "gmail +draft --to bill@psd401.net --subject 'Follow up' --body-file /tmp/draft-body.txt"

# NO BINARY EMAIL ATTACHMENTS on a draft. `+draft` builds a single-part text
# (or --html) message; it takes no attachment flag. gws's own attachment
# support (`-a/--attach`) exists only on +send/+reply/+forward, and all of
# those are Phase-1 forbidden, so there is no reachable path that attaches a
# file to mail.
#
# Deliver the file as a LINK instead, and say so plainly in the same turn:
#   - audio from psd-tts, video from psd-hyperframes, images from psd-image-gen
#     already return a public HTTPS URL — paste that URL in the draft body
#   - anything else: publish it with
#     `node /opt/psd-skills/psd-publish-file/publish.js --file <path>`, which
#     returns a shareable HTTPS URL — paste that in the draft body
#
# `drive +upload <path>` is NOT the answer and is refused: gws runs in an empty
# temporary directory on the web tier, so a container path does not exist there
# at all. Use psd-publish-file. (HTML pages go to Atrium via psd-html-artifact.)
#
# Do not hand-build a multipart/mixed MIME payload to get around this. It is
# not a transport limitation you can re-encode past, and on 2026-08-10 a user
# lost a turn to that attempt before falling back to a link.

# Chat message text (+send) uses --text-file (replaces --text)
# Only send after the user explicitly confirms the message. Chat writes must
# use the agent identity; the trusted broker rejects them on the human slot.
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

- **No sending mail.** `gmail.users.messages.send`, `gmail.users.drafts.send`, and the Gmail helper verbs `gmail +send`, `gmail +reply`, `gmail +reply-all`, `gmail +forward` — all blocked. Drafts only. These gates are Gmail-scoped: `chat +send` is a separate, allowed operation (agent slot only, see above) and is not covered by this boundary.
- **No deletes.** Mail (delete/trash/batchDelete), events, calendars, Drive files, drive trash, tasks, tasklists.
- **No permission changes.** `drive.permissions.create/update/delete` (except the explicit in-district shapes below).
- **No file creation as the user.** `drive files create/copy`, `docs documents create`, `sheets spreadsheets create`, `slides presentations create` on `--scope user` are hard-blocked — a file created there is owned by the user's account (impersonation; no attribution trail). Create with `--scope agent`, then share explicitly. **One exception, added 2026-07-25 (#1305):** `drive files create` with `mimeType` exactly `application/vnd.google-apps.folder` is allowed, because a folder carries no content and creating one is organizing, not authoring. The mimeType is matched exactly — a shortcut, a Doc, or a lookalike mimeType still refuses — and any media/upload flag alongside it refuses too. Nothing else gets through, and no phrasing changes that.
- **User-slot `drive files update` is metadata-only.** Rename, move, star, describe and recolour are allowed; anything else — an unrecognised field, a media/upload flag, or `{"trashed":true}` — refuses the whole call. The allowlist is all-or-nothing: one unknown key poisons the payload.

**Exception — explicit in-district shares of YOUR OWN files.** `drive.permissions.create` is permitted only on files the agent owns (`--scope agent`), only as `create` (never update/delete), and only in these explicit shapes:

- **Named person in the district:** `type: "user"`, `role: "reader"`, `"commenter"`, or `"writer"`, `emailAddress` ending `@psd401.net` — the caller or any district colleague. Writer is for explicitly named individuals only (e.g. each member of a team space, enumerated by name) — when a group needs to edit, grant each person, never the domain.
- **Whole district, read-only:** `type: "domain"`, `domain: "psd401.net"`, `role: "reader"` — use when a doc's link is going into a shared Chat space so every member can open it.

**Giving a file to the CALLER is unrestricted — including ownership.** The two
shapes above bound what the agent may hand to *third parties*; they do not stand
between it and its own owner. A share whose `emailAddress` is the caller is
permitted in any role, `owner` included, with `transferOwnership: true`.

Do that whenever a user asks to own, move, organize or delete something you
made. Files you create are owned by your agent account, and Drive only lets an
**owner** trash a file — so without the transfer the user cannot delete their own
document and has to open an IT ticket (issue #1636, reported 2026-08-12).
Offer the transfer when you hand over anything they will keep.

**Transfer LAST. Write the whole file before you hand it over.** Ownership
transfer is the final step of a handover, never a step in the middle of one. Once
the file belongs to the caller it is no longer yours to author, and further
writes — `docs.documents.batchUpdate`, `sheets.spreadsheets.values.update`,
`slides.presentations.batchUpdate`, `forms.forms.batchUpdate` — can come back
403 from Drive. That is what happened on 2026-08-26: a Doc was created,
transferred, and only then populated, so all three batchUpdate attempts were
refused and the user got an empty document (failure 13767).

The order is always: create → populate → verify → transfer. If you have already
transferred and still need to write, do not retry the write — say the file is
now the caller's and ask them to make the edit, or create a fresh doc.

Never allowed: `type: "anyone"` or `"group"`, external addresses/domains,
domain-wide `writer`, `owner` transfer **to anyone other than the caller**, or
any permission change on user-owned files.

Examples:

```bash
# Hand an artifact back to the caller
gws drive.permissions.create --scope agent --user hagelk@psd401.net \
  --json '{"fileId":"<id>","type":"user","role":"reader","emailAddress":"hagelk@psd401.net"}'

# Give the caller OWNERSHIP, so they can organize and delete it themselves.
# transferOwnership is a QUERY parameter, so it goes in --params, not --json.
gws drive.permissions.create --scope agent --user hagelk@psd401.net \
  --params '{"fileId":"<id>","transferOwnership":true}' \
  --json '{"type":"user","role":"owner","emailAddress":"hagelk@psd401.net"}'

# Make a doc readable district-wide before posting its link in a Chat space
gws drive.permissions.create --scope agent --user hagelk@psd401.net \
  --json '{"fileId":"<id>","type":"domain","role":"reader","domain":"psd401.net"}'
```

**Google Forms.** Create and populate a Form on the agent slot, then hand it
over — transfer ownership to the caller, or share it, exactly as with a Doc:

```bash
gws forms.forms.create --scope agent --user hagelk@psd401.net \
  --json '{"info":{"title":"TPEP Self-Assessment"}}'
gws forms.forms.batchUpdate --scope agent --user hagelk@psd401.net \
  --params '{"formId":"<id>"}' --json '{"requests":[…]}'
```

**Commenting on someone else's file.** Phase 1 blocks editing a doc the agent
does not own, but a COMMENT is additive and attributed, so it is allowed on the
agent slot — use it instead of asking the user to paste content:

```bash
gws drive.comments.create --scope agent --user hagelk@psd401.net \
  --params '{"fileId":"<id>"}' --json '{"content":"Suggested reordering: …"}'
```

**Gmail labels.** Creating a label in the user's own mailbox is organizing, not
authoring, so it stays on the user slot (`gmail.modify` covers it):

```bash
gws gmail.users.labels.create --scope user --user hagelk@psd401.net \
  --json '{"name":"Digested"}'
```

**Gmail filters.** Same reasoning as labels — a filter organizes the user's own
inbox — so it is on the user slot too. List, create and delete are all allowed:

```bash
gws gmail.users.settings.filters.list --scope user --user hagelk@psd401.net

# Skip the inbox and label instead. Get label IDs from gmail.users.labels.list;
# INBOX and UNREAD are built-in ids you can remove directly.
gws gmail.users.settings.filters.create --scope user --user hagelk@psd401.net \
  --json '{"criteria":{"from":"eoc-alarms@psd401.net"},
           "action":{"addLabelIds":["Label_12"],"removeLabelIds":["INBOX"]}}'

gws gmail.users.settings.filters.delete --scope user --user hagelk@psd401.net \
  --params '{"id":"<filterId>"}'
```

Filters need `gmail.settings.basic`, which `gmail.modify` does NOT include, so
a user whose connection predates 2026-08-28 gets `scope-upgrade-required` on
the first filter call. That is the ordinary re-consent path — hand them the
link and retry after they authorize; it is not a failure to report.

Two things this does NOT cover, both by design: **forwarding addresses** and
**send-as aliases / delegates** live behind `gmail.settings.sharing`, which is
not granted. If a user asks you to stop mail being forwarded away, you can
remove the FILTER that forwards it, but you cannot remove a
Settings → Forwarding rule — say so and point them at Gmail settings.

**Granting a request someone already made.** When a user hits "request access" on an
agent-owned file, Drive records an access proposal. List them with
`drive accessproposals list` and grant one with `drive accessproposals resolve`
— the same reader/commenter/writer ceiling as a named share, never `owner`:

```bash
gws drive.accessproposals.resolve --scope agent --user hagelk@psd401.net \
  --params '{"fileId":"<id>","proposalId":"<id>"}' \
  --json '{"action":"accept","role":"writer"}'
```

The two IDs address the endpoint, so they ride `--params`; `action` and `role`
are the request body and ride `--json` — the same split as every other command
in this skill.

Use `"action":"deny"` to decline; a denial needs no role.

When you post a doc link into a shared Chat space, share it district-wide (domain/reader) FIRST — otherwise members hit "request access". Anything outside these shapes is still blocked.

If a user explicitly asks the agent to send something, post the draft + a clear "I drafted it; reply 'send' if it's right" in Chat instead. The user clicks send themselves.

## Marker conventions (auto-injected on writes)

The skill silently adds these to every write:

- **Calendar event create/update/patch** → description prepended with `🤖 Created by your agent on YYYY-MM-DD.`
- **Drive file create** → filename prefixed `[Agent] `, `appProperties.psdAgentCreated=true`
- **Gmail draft create** (when body is in the `.message.body` field) → footer `— Drafted by your agent. Review before sending.`

You don't need to remember to add markers — the skill does it. **Do not** strip them or instruct the user to strip them; they're the audit substrate.

## Where the token comes from

- The model-facing skill never receives a Google token for either slot.
- It submits an allowlisted argv array to `/api/agent/workspace-execute`.
- The trusted web broker derives the owner from the signed invocation context,
  obtains the appropriate user/agent credential, executes the pinned Workspace
  CLI outside the model boundary, and returns bounded output.
- First-time/revoked user access and unprovisioned agent accounts remain
  structured broker outcomes; no reusable access token is returned.

Neither slot reads the `psd_agent_workspace_tokens` DB manifest in the model runtime —
that manifest exists for the admin dashboard (operator-visible connection
health), not runtime availability.

## Output contract

- **Success (exit 0):** stdout is whatever `gws` produced (usually JSON). Pass through.
- **Needs auth (exit 10):** stdout is a single JSON line `{"status":"needs-auth","consent_url":"...","consent_chat_hyperlink":"<url|label>","kind":"user_account|agent_account","message":"..."}`. **Paste `consent_chat_hyperlink` exactly, on a line by itself** — no `**`, no `[]()`, no parentheses, no period, no surrounding text on the same line. Then on a *separate* line explain what it is (use the `kind` field — "I need permission to read your inbox" vs "I need to connect my agent account"). Do not retry. **Why this matters:** wrapping the URL in markdown breaks Google Chat's URL parsing and corrupts the JWT signature in transit (incident 2026-04-27). The `<url|label>` form is Chat's native hyperlink syntax — Chat renders it as a clickable link without ambiguity.
- **Token revoked (exit 11):** stdout is `{"status":"token-revoked","consent_url":"...","consent_chat_hyperlink":"<url|label>","kind":"...","message":"..."}`. Same rule: paste `consent_chat_hyperlink` on its own line, no surrounding markdown, then ask the user to re-authorize on a separate line.
- **Broker rejection or transport error (exit 12):** trusted command-validator failures emit stdout JSON `{"status":"workspace-command-rejected","error":"...","reason":"operation_not_allowed|workspace_command_rejected","operation":"..."}`. Use `reason` and `operation` directly; do not parse `error`. Other exit-12 failures remain `gws`-style stderr because the skill couldn't reach the broker or Google (network/5xx); those are transient, so tell the user Workspace access is temporarily unavailable and to try again shortly. Do not paste a consent link (there isn't one). **`error[api]: File not found: <id>` is NOT one of the transient ones — never retry it.** See *When Drive says a file does not exist* below.
- **Phase 1 forbidden (exit 13):** stdout is `{"status":"phase1-forbidden","reason":"<short>","message":"<longer>"}`. The user asked you to do something Phase 1 disallows (send mail, delete, etc.). Tell them what you can do instead — usually "I'll draft it; reply 'send' if it's right." Do **not** retry with a workaround.
- **Account provisioning (exit 14):** stdout is `{"status":"account-provisioning","kind":"agent_account","message":"..."}`. Only the **agent slot** produces this: your `agnt_` Workspace account is being created automatically. Tell the user their agent account is being set up and to try again in about 30 minutes. There is **NOTHING to click** — do not show a consent link, do not retry in the same turn.
- **Scope upgrade required (exit 15):** stdout is `{"status":"scope-upgrade-required","consent_url":"...","consent_chat_hyperlink":"<url|label>","kind":"user_account","missing_scopes":[...],"message":"..."}`. Only the **user slot** produces this, and only for the Drive read/organize operations added in #1305: the user authorized you *before* that feature existed, so their stored token predates the scope. Same rule as exits 10/11 — paste `consent_chat_hyperlink` on its own line, no surrounding markdown, then on a separate line say *"I need one more permission to read your Drive — click the link to grant it."* Frame it as **one more permission**, not as "you never authorized me" (exit 10) or "your access was revoked" (exit 11). Do not retry until the user confirms they clicked it.
- **gws failure (exit 2+):** `gws` stderr is surfaced. Report the error to the user; do not invent workarounds.

### When Drive says a file does not exist

`error[api]: File not found: <id>` does **not** mean the file is missing, and
retrying will never change it. Drive returns 404 rather than 403 for a file you
cannot currently see, so "does not exist" and "exists, not visible to me" are
the same message.

The broker now sets `supportsAllDrives` on every Drive call, which removes the
most common cause — a file living in a **Shared Drive**, which Drive hides
entirely from clients that do not declare shared-drive support even when the
file has been shared with you directly. You do not need to pass it yourself.

If you still get a 404 after one attempt, stop and work the two real causes:

1. **The share landed on the wrong account.** You are two identities. On
   `--scope agent` you are `agnt_<user>@psd401.net`; on `--scope user` you are
   the caller. Sharing with the caller does not grant the agent slot access, and
   vice versa. Tell the user the **exact address** to share with — say
   `agnt_<their-uniqname>@psd401.net` in full, don't say "the agent account".
2. **Retry once on the other scope.** If `--scope user` 404s, try
   `--scope agent` and the reverse; that identifies which identity is missing
   the share without guessing.

Then report it under Rule 11 with the fileId and both scopes you tried. Do not
loop. On 2026-08-14 a supervision schedule was retried nine times across eight
minutes, re-shared as a different file type, and still abandoned — the user had
shared it correctly the whole time (agent_failures 8289, 8322).

### When Drive says you exceeded your sharing quota

`Rate limit exceeded: Sorry, you have exceeded your sharing quota` on
`drive.permissions.create` is a Google anti-abuse throttle on the SHARING
account, not a transient error and not a problem with the file. It is most
common on a freshly-provisioned `agnt_` account, whose sharing allowance starts
low and rises over its first days.

Retrying inside the turn cannot clear it — the window is hours, not seconds. On
2026-08-24 and 2026-08-25 two turns each burned three attempts and ~90 seconds
of the user's clock before giving up (failures 12744, 13241).

So on this error, once:

1. **Stop.** Do not retry, and do not try a different role — `writer` hits the
   same quota as `owner`.
2. **Give them the file anyway.** The document is built and live; only the
   share failed. Send the `https://docs.google.com/…/d/<id>` link, and say the
   file is currently owned by `agnt_<their-uniqname>@psd401.net`.
3. **Say what to do.** Either they ask you to share it again later, or they open
   it via the link and copy it into their own Drive now.

Never report this as "I could not create the document" — the document exists.

**Google Tasks.** The agent may add tasks to the user's own lists and reorder
them — `tasks.tasks.insert`, `tasks.tasks.move` — on the user slot. `move`
takes the destination in `--params`, not `--json`:

```bash
# Put a task directly under a heading task, as its child.
gws tasks.tasks.move --scope user --user hagelk@psd401.net \
  --params '{"tasklist":"@default","task":"<taskId>","parent":"<headingTaskId>"}'

# Or just reposition it after another task at the same level.
gws tasks.tasks.move --scope user --user hagelk@psd401.net \
  --params '{"tasklist":"@default","task":"<taskId>","previous":"<afterTaskId>"}'
```

Deleting tasks or task lists stays forbidden on both slots (Phase 1).

**Finding a person's DM space.** To deliver into your one-to-one Chat with
someone, resolve the space first — `chat.spaces.list` only returns spaces that
already exist for you, so a DM you have never used will not appear there:

```bash
gws chat.spaces.findDirectMessage --scope agent --user hagelk@psd401.net \
  --params '{"name":"users/<googleUserId>"}'
```

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
