---
name: psd-atrium
summary: Read and write AI Studio Atrium content — PSD's collaborative document + live-artifact workspace with an intranet publishing flow. Find/read/create/edit/archive/delete documents and artifacts, embed images in them, and publish them, version-based, over /api/v1/content. Artifacts fully support HTML/CSS/JavaScript (including <script>/<style>).
description: Use this to work with Atrium, PSD's collaborative content workspace in AI Studio (documents + interactive artifacts, with an internal "intranet" publishing flow). Find and read Atrium documents/artifacts, create new ones, edit them (append or replace), archive them, hard-delete ones you own, and publish/unpublish to a destination. Interactive artifacts fully support real HTML, CSS, and JavaScript — including <script>, <style>, and inline style="…" — pass raw code; the skill base64-encodes it automatically so nothing is stripped or blocked (do NOT work around with legacy attributes like bgcolor/width). Atrium is REAL and live — never say the district has no content workspace. Version-based: reads return the last saved version and edits create a new version; the real-time collaborative editor rail is not reachable from here.
allowed-tools: Bash(node:*)
---

# psd-atrium

**Atrium** is AI Studio's collaborative content workspace: staff author
**documents** (markdown) and interactive **artifacts** (HTML/JS or JSX) together,
organize them into collections, control who can view them, and **publish** them to
internal destinations (the "intranet" reader) — with a review gate before anything
goes public. This skill lets you (the agent) act on that content through AI
Studio's owner-bound internal broker.

Use it to answer "what's in Atrium about X?", to read a document/artifact, to draft
a new one, to revise one, or to publish one internally.

## What this skill can and cannot do

**Version-based (what you get here):** reads return the **last saved version**;
writes create a **new version**, using the same shared services as the MCP/REST
surfaces.

**NOT reachable here** (session-only, by design — do not claim you can do these):

- The **live collaborative editor rail** (real-time keystrokes on the purple agent
  rail, `comment`, and track-changes `suggest`). Those run only for a logged-in
  human in the in-app editor. Your writes land as new versions in the history, not
  as live-editor edits.
- A document open in the editor may be **ahead** of what `read` returns until
  someone snapshots a version.
- **A document's body TEXT** is not returned by `read` at all — it lives in the
  collaborative store. `read` gives a document's metadata; only small **artifact**
  code comes back inline. Use **`read-source`** to get a document's committed
  body text, and `edit --mode replace` to write a new one.

## Authentication & identity

The skill calls an owner-bound internal broker. Its signed invocation proof names
the workspace owner; the web tier resolves that active user to an Atrium
Requester and calls the shared content services directly. No reusable content
credential enters the workspace.

You act as **the signed workspace owner** — reads and writes are visibility-,
ownership-, and capability-gated by that user's authority. Operations are
attributed to that owner, never to a shared service principal.

## Subcommands

    node /opt/psd-skills/psd-atrium/run.js <subcommand> [flags]

### Read

```bash
# Find content you can view (permission-filtered). All filters optional.
node run.js find --kind document --query "field trip" --status published --since "2026-07-27T00:00:00Z"

# Read one object + its last saved version.
# Document TEXT is NOT returned here — it lives in the collaborative store, so
# `read` gives a document's metadata only. Small ARTIFACT code IS returned inline
# (in `body`); large artifacts are offloaded to storage and not inlined.
node run.js read --id <uuid-or-slug>

# Read a DOCUMENT's committed body text. This is the one command that returns it.
node run.js read-source --id <uuid-or-slug>
```

`find` filters: `--kind document|artifact`, `--collection <slug|id>`, `--tag <t>`,
`--status draft|published|archived`, `--query <title text>` (case-insensitive),
`--since <ISO-8601 timestamp>` (inclusive `updatedAt` lower bound). Each returned
item includes its canonical `url`.

`read-source` returns the last **committed** version's source. A document someone
has open in the live editor may be **ahead** of this until a version is snapshotted
— say so rather than presenting it as the current text.

### Manage collections

Every owner can create and manage an owner-bound private hierarchy. A private
collection may be nested only below another collection owned by that same user;
it cannot carry grants or widen its default visibility. Administrators can also
manage the district/shared hierarchy and assign role/group `view` and `create`
access independently.

```bash
node run.js list-collections
node run.js create-collection --name "My projects" --scope private
node run.js create-collection --name "HR" --scope district \
  --parent root --default-visibility internal \
  --grants view:role:staff,create:group:hr-editors@psd401.net
node run.js edit-collection --id <uuid> --name "People Operations" --position 2
node run.js move-collection --id <uuid> --parent <parent-uuid> --position 0
node run.js archive-collection --id <uuid>
node run.js restore-collection --id <uuid>
```

- Use the collection UUID returned by `list-collections` for mutation commands.
- `list-collections` returns both active and archived manageable collections,
  including `archivedAt`, direct grants, `directContentCount`, and
  `subtreeContentCount`; use it to rediscover a UUID before restoring a subtree.
- `--parent root` moves to the top level.
- `--grants none` clears direct grants. Grant entries are
  `view|create:role|group:<value>` (the API also accepts the other Atrium grant
  kinds).
- An archive/restore applies to the selected collection and its full subtree;
  content is retained. Content counts include both `directContentCount` and
  `subtreeContentCount`, so those meanings are never ambiguous.
- Collection slugs stay stable across renames. Sibling names must be unique and
  moving a collection below itself or a descendant is rejected.

### Images (authored assets)

An image belongs to **one object**. Embedding it is a three-step flow, and the
order matters: the object must exist before an asset can be attached to it, and
the asset must be `ready` before a version may reference it.

```bash
# 1. create the document (or use an existing one)
# 2. attach the image — reserves, uploads, and completes in one command
node run.js upload-asset --id <objectId> --file /tmp/panel.png --alt "Printer control panel"
# 3. put the returned `directive` on its OWN LINE in the body, then:
node run.js edit --id <objectId> --body "<full markdown incl. the directive>"

# List what is already attached, or copy an image OUT of an object.
node run.js list-assets --id <objectId>
node run.js get-asset --id <objectId> --asset-id <assetId> --out /tmp/copy.png
```

- **PNG, JPEG, and WebP only**, 20 MiB max. The type is detected from the file's
  magic bytes, not its name — renaming a PDF to `.png` is refused.
- **Assets do not cross objects.** A directive referencing an asset owned by a
  different object is rejected when the version is saved. To reuse an image,
  `get-asset` it from the source object and `upload-asset` it to the new one.
- Always give `--alt`. Without it the alt text becomes the filename, which is
  useless to a screen reader.
- A plain markdown `![alt](https://…)` image also works for an image already
  hosted at a stable public URL. `data:` URIs do **not** — they are stripped.

### Create (starts **private + draft**)

```bash
node run.js create-document --title "Sample" --markdown "# Hello" [--collection <slug|id>] [--tags a,b]
node run.js create-artifact --title "Chart" --code "<html><style>…</style><script>…</script></html>" --body-format html
```

> **Pass a LARGE body through a file, not an argument.** `--markdown-file`
> (create-document), `--body-file` (edit), and `--code-file` (create-artifact)
> read the content from disk. This is not just tidiness: one argv value is capped
> at 128 KiB (`MAX_ARG_STRLEN`), so a long document fails the spawn with `E2BIG`
> before this skill even starts — far below the 4 MiB the API itself accepts. If
> you have written the content to a file already, prefer the file flag every
> time. Passing both the inline and file form of the same body is an error, not
> a silent preference for one.

> **Artifact code fully supports HTML, CSS, and JavaScript — including
> `<script>`, `<style>`, and inline `style="…"`.** Pass raw code; the skill
> base64-encodes every write body automatically so it is opaque to AI Studio's
> edge firewall (which would otherwise 403 a raw body that looks like markup) and
> decoded server-side before it is stored. There is **no need** to avoid `<script>`
> / `<style>` or fall back to legacy attributes like `bgcolor`/`width` — real
> JS/CSS is the intended way to build an artifact. Artifacts render only inside a
> cross-origin sandboxed iframe, never on the app origin.

Optional on both: `--visibility private|group|internal|public` and
`--grants role:staff,building:GHS` (group grants). Requesting `public` needs the
human-held `content:publish_public`; **without it the object is created PRIVATE**
and a widen-to-public request is queued for admin approval. Unlike publish, the API
returns no explicit signal for this, so the skill compares requested vs. returned
visibility and adds `approvalRequired: true` + a `visibilityNote` when they differ —
relay that the widen is **pending approval**, not that the object is public.

> Edge case the skill can't auto-flag: if you create **into a collection whose
> default visibility is public** and pass **no** `--visibility`, the same downgrade
> happens server-side, but with nothing to diff against the skill can't add the
> note. Always trust the returned `visibilityLevel` over what you expected.

### Edit (creates a new version)

```bash
node run.js edit --id <id> --body "new full text"                 # replace (default)
node run.js edit --id <id> --body-file /tmp/new-body.md           # same, from a file
node run.js edit --id <id> --body "extra paragraph" --mode append # append to saved body
```

`--mode append` reads the last saved body and concatenates; it only works when that
body is returned inline (small content). For a large (externally stored) body, use
`--mode replace` with the full text. Optional: `--body-format markdown|html|jsx`,
`--summary <change note>`.

### Archive (soft-remove — reversible)

```bash
node run.js archive --id <id>
```

Flips the object's status to `archived` (via the metadata PATCH; needs the
owner's Atrium authoring authority). Reversible, and the object still
shows up under `find --status archived`. Archiving also takes any live publication
offline. Prefer archive when you might want the content back; use `delete` (below)
only when it should be gone for good.

### Delete (HARD, permanent)

```bash
node run.js delete --id <id>
```

Permanently removes the object and **every** version, body, comment, and index
entry. There is **no undo** — after this, `find`/`read` no longer return it and the
reader/editor URLs 404. Needs owner-authorized content deletion.

Two guardrails the server enforces — relay either refusal verbatim:

- **Owner-only.** You delete as the signed workspace owner, so you can only delete
  content that owner owns. Deleting someone else's object returns a `403` error
  (the object's existence is masked as `404` if you couldn't view it at all).
- **Unpublish first.** A published object is refused with a clear `409` message
  ("unpublish from … first"); delete NEVER auto-unpublishes. Run
  `unpublish --id <id> --destination <d>` for each live destination, then `delete`.

Use `archive` for reversible cleanup and `delete` only for permanent removal of
throwaway/superseded content you own.

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
request was queued for a human/admin to approve. A completed publish includes
`readerUrl` when the destination has a reader link.

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
| 11 | Unauthorized — signed owner authority is unavailable | Tell the user Atrium access isn't configured; do not retry |
| 12 | Upstream content-API error (403 forbidden / 404 not found / 422 blocked / 5xx) or network | Surface the error verbatim |
| 14 | Rate-limited | Wait a moment, retry once |

## Rules

1. **Atrium exists.** Never tell a user the district has no collaborative content
   workspace — read/list it live before answering "what's in Atrium?".
2. **Version-based only.** Your reads are the last saved version and your writes are
   new versions; you cannot type on the live editor rail or leave live
   comments/suggestions.
2b. **Preserve images.** If a source document has screenshots or diagrams, carry
   them over with `upload-asset` — do not replace a picture with a description of
   the picture.
3. **You act as the signed workspace owner.** Do not imply a shared service
   principal owns or authorized the operation.
4. **Relay approval_required verbatim.** A queued public publish is not a failure —
   tell the user it is awaiting approval.
5. **New content is private + draft.** Creating does not publish or share it; use
   `publish` (destination) and/or `set-visibility` as separate, explicit steps.
6. **Your writes use the signed owner's requester.** Keep everything you write
   appropriate; it is attributed to, and gated by, that user's permissions.
