---
name: psd-atrium
summary: Read and write AI Studio Atrium content — PSD's collaborative document + live-artifact workspace with an intranet publishing flow. Find/read/create/edit documents and artifacts and publish them, version-based, over /api/v1/content.
description: Use this to work with Atrium, PSD's collaborative content workspace in AI Studio (documents + interactive artifacts, with an internal "intranet" publishing flow). Find and read Atrium documents/artifacts, create new ones, edit them (append or replace), and publish/unpublish to a destination. Atrium is REAL and live — never say the district has no content workspace. Version-based: reads return the last saved version and edits create a new version; the real-time collaborative editor rail is not reachable from here.
allowed-tools: Bash(node:*)
---

# psd-atrium

**Atrium** is AI Studio's collaborative content workspace: staff author
**documents** (markdown) and interactive **artifacts** (HTML/JS or JSX) together,
organize them into collections, control who can view them, and **publish** them to
internal destinations (the "intranet" reader) — with a review gate before anything
goes public. This skill lets you (the agent) act on that content over AI Studio's
`/api/v1/content` REST API.

Use it to answer "what's in Atrium about X?", to read a document/artifact, to draft
a new one, to revise one, or to publish one internally.

## What this skill can and cannot do

**Version-based (what you get here):** reads return the **last saved version**;
writes create a **new version**. This is the same surface any `sk-`-keyed MCP/REST
client uses.

**NOT reachable here** (session-only, by design — do not claim you can do these):

- The **live collaborative editor rail** (real-time keystrokes on the purple agent
  rail, `comment`, and track-changes `suggest`). Those run only for a logged-in
  human in the in-app editor. Your writes land as new versions in the history, not
  as live-editor edits.
- A document open in the editor may be **ahead** of what `read` returns until
  someone snapshots a version.
- **A document's body TEXT** is not returned by `read` at all — it lives in the
  collaborative store. `read` gives a document's metadata; only small **artifact**
  code comes back inline. You can still **replace** a document's body with
  `edit --mode replace` (a full new version), you just can't read the old text
  back or `append` to it.

## Authentication & identity

The skill authenticates with a single scoped `sk-` **content key** (holding
`content:` scopes), read from `AISTUDIO_CONTENT_API_KEY` or from Secrets Manager via
`AISTUDIO_CONTENT_API_KEY_SECRET_ID`. You do not handle auth yourself.

You act as **that key's owner identity** — reads and writes are visibility-gated by
that user's roles (an agent does what that person could do). This is **not**
per-caller delegation: every operation is attributed to the content key's owner, not
to the specific user who asked you. Per-user delegated tokens
(`/api/v1/agents/delegated-token`) are a designed later phase and are **not
provisioned yet** — see `docs/features/atrium-agent-access.md`.

## Subcommands

    node /opt/psd-skills/psd-atrium/run.js <subcommand> [flags]

### Read

```bash
# Find content you can view (permission-filtered). All filters optional.
node run.js find --kind document --query "field trip" --status published

# Read one object + its last saved version.
# Document TEXT is NOT returned here — it lives in the collaborative store, so
# `read` gives a document's metadata only. Small ARTIFACT code IS returned inline
# (in `body`); large artifacts are offloaded to storage and not inlined.
node run.js read --id <uuid-or-slug>
```

`find` filters: `--kind document|artifact`, `--collection <slug|id>`, `--tag <t>`,
`--status draft|published|archived`, `--query <title text>` (case-insensitive).

### Create (starts **private + draft**)

```bash
node run.js create-document --title "Sample" --markdown "# Hello" [--collection <slug|id>] [--tags a,b]
node run.js create-artifact --title "Chart" --code "<html>…</html>" --body-format html
```

Optional on both: `--visibility private|group|internal|public` and
`--grants role:staff,building:GHS` (group grants; widening to `public` needs the
human-held `content:publish_public` — otherwise it returns queued-for-approval).

### Edit (creates a new version)

```bash
node run.js edit --id <id> --body "new full text"                 # replace (default)
node run.js edit --id <id> --body "extra paragraph" --mode append # append to saved body
```

`--mode append` reads the last saved body and concatenates; it only works when that
body is returned inline (small content). For a large (externally stored) body, use
`--mode replace` with the full text. Optional: `--body-format markdown|html|jsx`,
`--summary <change note>`.

### Publish / unpublish (honor the approval gate)

```bash
node run.js publish   --id <id> --destination intranet      # internal reader (default)
node run.js publish   --id <id> --destination public_web    # may return queued-for-approval
node run.js unpublish --id <id> --destination intranet
```

`intranet` (and other internal destinations) publish directly with
`content:publish_internal`. A **public** destination the key may not publish
directly returns a structured **approval_required** result (HTTP 202) — this is a
SUCCESS, not an error. **Relay its `message` verbatim** so the user knows the
request was queued for a human/admin to approve.

### Change who can view it

```bash
node run.js set-visibility --id <id> --level internal
node run.js set-visibility --id <id> --level group --grants role:staff,building:GHS
```

## Output contract

- **Success (exit 0):** stdout is the JSON result (object, list, created ids, new
  version id, etc.).
- **approval_required (exit 0):** `{ "status": "approval_required", "message": "…",
  "approvalRequired": true }` — a public op queued for approval. Relay the message.
- **Errors:** structured JSON on stdout/stderr with a non-zero exit (see below).

## Exit codes

| Code | Meaning | Agent response |
|------|---------|----------------|
| 0 | Success (incl. approval_required) | Use the result |
| 1 | Config / usage error | Fix the invocation; do not retry blindly |
| 11 | Unauthorized — content key missing/invalid or lacks the scope | Tell the user Atrium access isn't configured; do not retry |
| 12 | Upstream content-API error (403 forbidden / 404 not found / 422 blocked / 5xx) or network | Surface the error verbatim |
| 14 | Rate-limited | Wait a moment, retry once |

## Rules

1. **Atrium exists.** Never tell a user the district has no collaborative content
   workspace — read/list it live before answering "what's in Atrium?".
2. **Version-based only.** Your reads are the last saved version and your writes are
   new versions; you cannot type on the live editor rail or leave live
   comments/suggestions.
3. **You act as the content key's owner, not the asking user.** Do not imply an edit
   is attributed to the person who asked (delegation is a future phase).
4. **Relay approval_required verbatim.** A queued public publish is not a failure —
   tell the user it is awaiting approval.
5. **New content is private + draft.** Creating does not publish or share it; use
   `publish` (destination) and/or `set-visibility` as separate, explicit steps.
6. **Screening.** Agent-authored text is safety-screened server-side before it
   persists; a blocked write returns an error (exit 12) — do not retry it verbatim.
