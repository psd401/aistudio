---
name: psd-atrium
summary: Read and write AI Studio Atrium content — PSD's collaborative document + live-artifact workspace with an intranet publishing flow. Find/read/create/edit/archive/delete documents and artifacts, embed images, add first-party artifact persistence with AtriumData, and publish them. Artifacts fully support HTML/CSS/JavaScript (including <script>/<style>).
description: Use this to work with Atrium, PSD's collaborative content workspace in AI Studio (documents + interactive artifacts, with an internal "intranet" publishing flow). Find and read Atrium documents/artifacts, create new ones, edit them (append or replace), add live artifact persistence with window.AtriumData, archive them, hard-delete ones you own, and publish/unpublish them (a Live/Draft state — it does NOT change who can read them; the visibility level does). Interactive artifacts fully support real HTML, CSS, and JavaScript — including <script>, <style>, and inline style="…" — pass raw code; the skill base64-encodes it in transit so AI Studio cannot mangle it (do NOT work around with legacy attributes like bgcolor/width). That protects the write, NOT the render: `data:` URIs are still stripped when the page is served, so images must be uploaded with upload-asset or referenced by public https URL. Atrium is REAL and live — never say the district has no content workspace. Version-based: reads return the last saved version and edits create a new version; the real-time collaborative editor rail is not reachable from here.
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
- `list-collections` returns active collections you can enter (including
  accessible district/shared collections) plus active and archived collections
  you can manage. Manageable rows include `archivedAt`, direct grants,
  `directContentCount`, and `subtreeContentCount`; use the command to rediscover
  a UUID before restoring a subtree.
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

> **A `data:` URI is NOT a way to put an image in Atrium.** Every `data:` URL
> is stripped from both markdown and artifact HTML before serving — the
> sanitizer's scheme allowlist is `https:`/`mailto:`/`tel:`/anchors/relative
> only. The write survives, the version saves, a read-back looks correct, and
> the served page shows nothing. Because nothing errors, the failure only
> surfaces when a human opens the page: one artifact reached a user with all
> **11** of its images blank this way (agent_failures 6408).
>
> This is a deliberate XSS/exfiltration boundary and will not be relaxed. Use
> `upload-asset` below, or reference an image already hosted at a public
> `https:` URL — `psd-image-gen`, `psd-tts` and `psd-hyperframes` all return
> exactly that kind of URL.
>
> The note in this skill's description that the body is base64-encoded "so
> nothing is stripped or blocked" is about the WRITE TRANSPORT — it stops AI
> Studio mangling your HTML in transit. It does not exempt the content from
> sanitization on the way out, and it is not a licence to inline base64 images.

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

### Persist data inside an artifact (`window.AtriumData`)

Use the first-party `window.AtriumData` bridge whenever an artifact must remember
scores, responses, progress, or other small JSON records across users or devices.
The sandbox host installs it before artifact scripts run. It is live in the
authenticated `/c/<slug>` reader; signed-out/public readers and preview-only
surfaces fail the bridge closed, so always catch rejections and show a signed-out
state.

`submit`/`list` require the artifact's data-access mode to be `records` — the
default, so nothing extra is needed. They are REFUSED on an artifact created with
`--data-access query`; see "Live PSD data" below for why the two can never be
combined.

```js
const created = await window.AtriumData.submit("leaderboard", {
  score: 1250,
  durationMs: 48210,
});
// => { id: "<record uuid>", createdAt: "<ISO timestamp>" }

const result = await window.AtriumData.list("leaderboard", {
  limit: 200,       // optional; defaults to 50 and is capped at 200
  scope: "all",    // optional: "all" (default) or "mine"
});
// => { records: [{ id, displayName, payload, createdAt }, ...] }
```

- Use a namespace matching `[a-z0-9_-]{1,64}`. Keep each submitted plain-JSON
  object at or below 8 KiB. Records are append-only.
- Treat `displayName` as authoritative. The authenticated server session supplies
  identity and attributes each record. **Never ask a player to type a name, put
  `userId`/`user_id` in the payload, or implement a name profanity filter.**
- Wrap every bridge call in `try`/`catch`. A disabled bridge, signed-out reader,
  timeout, invalid input, or denied content access rejects the Promise.

### Live PSD data inside an artifact (`window.AtriumData.query`)

For a dashboard that must show CURRENT district data, create the artifact with
`--data-access query` and call `window.AtriumData.query()` at runtime. The query
runs on the PSD Data MCP **as the person viewing the page**, under that viewer's
own row-level permissions — a principal and a district admin opening the same
dashboard see different numbers, which is the point.

```bash
node run.js create-artifact --title "Enrollment dashboard" \
  --code-file /tmp/dashboard.html --body-format html --data-access query
```

```js
const { columns, rows, totalCount, truncated } = await window.AtriumData.query(
  "SELECT school_name, COUNT(*) AS enrolled FROM enrollment GROUP BY school_name",
  { limit: 200, offset: 0 }   // optional; limit is capped at 2000
);
// rows are tuples in `columns` order: [["Peninsula HS", 1234], ...]
```

Rules — follow all of them:

- **Never embed query results in the artifact source.** Baked-in numbers are
  stale the moment you write them AND they show every viewer data at YOUR
  permission level; the Code tab exposes them verbatim. Query at runtime.
- **Aggregate in SQL.** A chart query should return tens of rows, not a dataset.
  Every call is a Lambda + database round trip.
- **Page detail tables** with `limit` / `offset` instead of one huge read.
- **Pass filters as query parameters** and re-query when the user changes them —
  do not fetch everything once and filter in JavaScript.
- **Test it before you publish it.** The bridge is live on the authoring
  surfaces — the full-screen viewer (`/atrium/<id>/view`, which the create/edit
  response links to), the editor canvas, and the "Open beside chat" panel — so
  open the returned link and confirm the query actually returns rows before you
  tell anyone the dashboard is ready. It stays OFF for embeds inside a document,
  library thumbnails, and the anonymous public reader `/p/<slug>`; a query-mode
  artifact is not usable on those surfaces at all.
- **Handle rejection.** Wrap every call in `try`/`catch` and render a sign-in /
  no-access state. A rejection means no session, an expired ID token (they last
  about an hour — tell the viewer to reload), no access to a table, the wrong
  data-access mode, or a rate limit (60 queries per artifact per minute).
- **`query` and `submit`/`list` are mutually exclusive.** An artifact in `query`
  mode cannot use the record store, and vice versa. This is a security boundary,
  not a limitation to work around: records are readable by the artifact's author,
  so an artifact that could do both would leak whatever its viewers can see. Do
  not ask for both; pick the one the artifact actually needs.
- You cannot influence `format`, `export`, the tool name, or the audit reason —
  they are forced server-side, and the audit log records the viewer's identity
  with the artifact id.
- Students never reach this bridge; the connector is staff/administrator only.

The following are **not live persistence options inside an Atrium artifact**:

- `fetch()` and `XMLHttpRequest` are blocked by the unchanged sandbox CSP
  `connect-src 'none'`.
- `localStorage` and `sessionStorage` throw because the sandboxed frame has an
  opaque origin; even device-local storage would not provide cross-device data.
- Google Forms/Sheets and Apps Script Web Apps require a network request from the
  artifact, so they are blocked by the same CSP and cannot be its live data source.
  Do not propose cron-generated JSON snapshots as a substitute for live records.

#### Complete copy-pasteable leaderboard

This standalone artifact submits at game end, loads on leaderboard open, renders
server-supplied names safely, and handles a signed-out or disabled bridge. A real
game can call `window.gameEnded(score)` from its existing game-over path.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Atrium leaderboard</title>
    <style>
      body { font: 16px system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; }
      form, header { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
      input { width: 8rem; }
      #leaderboard { margin-top: 1.5rem; }
      #scores[hidden] { display: none; }
    </style>
  </head>
  <body>
    <h1>Game</h1>
    <form id="game-over-form">
      <label>Final score <input id="final-score" type="number" min="0" required /></label>
      <button type="submit">End game</button>
    </form>

    <section id="leaderboard" aria-labelledby="leaderboard-title">
      <header>
        <h2 id="leaderboard-title">Leaderboard</h2>
        <button id="open-leaderboard" type="button">Open leaderboard</button>
      </header>
      <p id="leaderboard-status" role="status">Open the leaderboard to load scores.</p>
      <ol id="scores" hidden></ol>
    </section>

    <script>
      (() => {
        "use strict";

        const NAMESPACE = "leaderboard";
        const status = document.getElementById("leaderboard-status");
        const scores = document.getElementById("scores");
        const form = document.getElementById("game-over-form");
        const scoreInput = document.getElementById("final-score");
        const openButton = document.getElementById("open-leaderboard");

        function bridgeAvailable() {
          return window.AtriumData &&
            typeof window.AtriumData.submit === "function" &&
            typeof window.AtriumData.list === "function";
        }

        function showSignedOut() {
          scores.replaceChildren();
          scores.hidden = true;
          status.textContent = "Sign in to see scores.";
        }

        function renderLeaderboard(records) {
          const ranked = records
            .filter((record) => Number.isFinite(Number(record.payload?.score)))
            .sort((a, b) => Number(b.payload.score) - Number(a.payload.score));

          scores.replaceChildren();
          for (const record of ranked) {
            const item = document.createElement("li");
            item.textContent = `${record.displayName} — ${Number(record.payload.score)}`;
            scores.appendChild(item);
          }
          scores.hidden = ranked.length === 0;
          status.textContent = ranked.length === 0 ? "No scores yet." : `${ranked.length} scores`;
        }

        async function loadLeaderboard() {
          if (!bridgeAvailable()) {
            showSignedOut();
            return;
          }
          status.textContent = "Loading scores…";
          try {
            const result = await window.AtriumData.list(NAMESPACE, {
              limit: 200,
              scope: "all",
            });
            renderLeaderboard(Array.isArray(result.records) ? result.records : []);
          } catch {
            showSignedOut();
          }
        }

        async function gameEnded(finalScore) {
          if (!bridgeAvailable()) {
            showSignedOut();
            return;
          }
          try {
            await window.AtriumData.submit(NAMESPACE, { score: Number(finalScore) });
            await loadLeaderboard();
          } catch {
            showSignedOut();
          }
        }

        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void gameEnded(scoreInput.valueAsNumber);
        });
        openButton.addEventListener("click", () => void loadLeaderboard());
        window.gameEnded = gameEnded;
      })();
    </script>
  </body>
</html>
```

#### Read records for a teacher-facing dashboard

Use the existing owner-bound Atrium client rather than inventing another data
client. `list-data` invokes the signed broker's `GET /<id>/data` operation:

```bash
node run.js list-data --id <artifact-uuid-or-slug> --namespace leaderboard --limit 200
```

The broker applies the signed workspace owner's visibility, confirms the target
is an artifact, and returns newest-first
`{ records: [{ id, displayName, payload, createdAt }] }`. It returns no email or
user id. This is the agent read path for building a teacher-facing dashboard;
artifact code itself must use `AtriumData.list()`. This broker surface is not an
`/api/v1/` endpoint.

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

### Publish / unpublish (Live or Draft — NOT an audience)

```bash
node run.js publish   --id <id>                             # make it Live
node run.js unpublish --id <id>                             # back to Draft
```

**Publishing does not change who can read it.** It makes the object LIVE: pins
the current version, gives it a page of its own at `/c/{slug}`, and puts it in
the published library. Who may open that page is the object's **level**, changed
only with `set-visibility` (below). So:

- Level `group` + Live → a real page that opens for its grantees and 404s for
  everyone else. That is correct, not a mistake.
- Level `public` + Live → also served at the anonymous `/p/{slug}`.
- Level `public` + Draft → `/p/{slug}` 404s. Publish it.

`--destination` still exists for backward compatibility; `intranet` and
`public_web` both mean the same single Live state, so **omit it**. A completed
publish includes `readerUrl`. **Hand that value out as-is** — do not build a link
from the slug. It is the `/c/` link for most content, and the public `/p/` link
when the object's level is Public, which is the only one an outside recipient can
open. Guessing `/c/` for a public page sends them to a sign-in wall.

Publishing can still be queued for review — a section whose administrator turned
review on returns a structured **approval_required** result (HTTP 202). That is a
SUCCESS, not an error: **relay its `message` verbatim** so the user knows a human
has to approve it. `set-visibility --level public` can return the same signal when
the key may not publish publicly.

**Paste every Atrium URL BARE — no backticks, no `[label](url)`, no bold, no
trailing period.** Put it on its own line.

A code-span is the trap here, not just a style nit: the trailing `` ` `` gets
carried into the click/copy, percent-encodes to `%60`, and the reader answers a
genuine 404. That cost a real diagnosis — server-side checks all passed
(`visibilityLevel=public`, `status=published`, a raw fetch returned HTTP 200)
while the user saw 404 on both `/c/` and `/p/`, because the URL being clicked
was not the URL that was published (agent_failures 7167, 7299).

Same rule already applies to Workspace consent links, for the same mechanical
reason. If a URL needs explaining, put the sentence on a SEPARATE line.

**Do not hand out a `/c/` link for an object that is still a draft or still
private.** Create starts private + draft, so a link shared before BOTH `publish`
and `set-visibility` 404s for the recipient even though the object exists and
reads back fine (agent_failures 5946, 7233). Publish it and set a level that
admits the recipient, or say plainly that it is not yet viewable.

### Change who can view it

```bash
node run.js set-visibility --id <id> --level internal
node run.js set-visibility --id <id> --level group --grants role:staff,building:GHS
```

This is the ONLY thing that changes the audience. Setting a level never
publishes, and publishing never changes a level — the two are independent, and a
shareable page needs both (Live, plus a level that admits the recipient).

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
7. **Persist artifact data only with `AtriumData`.** Never substitute Sheets,
   Apps Script, direct network calls, or browser storage for live artifact data.
