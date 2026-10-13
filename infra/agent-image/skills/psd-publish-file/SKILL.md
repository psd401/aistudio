---
name: psd-publish-file
summary: Hand a file you just generated to the person who asked for it — privately into their Drive by default, or as a public link when the content is genuinely public. PDFs, Word, Excel, PowerPoint, images, CSVs, audio, video.
description: Deliver a local file the agent produced. By default it is created in the agent's own Google Drive and shared with the caller alone (PDF, DOCX, XLSX, PPTX, CSV, MD, TXT, PNG, JPEG, WEBP). With --to public it becomes an unsigned public-by-link URL that anyone can open and that expires after 30 days (PDF, PNG, JPEG, WEBP, SVG, CSV, JSON, MD, TXT, MP3, MP4). Use when the user asks for a file, a link to a file, or to share or send one. Not for HTML pages — those go to Atrium via psd-html-artifact.
allowed-tools: Bash(node:*)
---

# psd-publish-file

You generated a file. The user needs it. **Run the command with no `--to` flag
and it goes to their Drive, privately. That is almost always what you want.**

```bash
node /opt/psd-skills/psd-publish-file/publish.js --file /tmp/<name>.pptx
```

Returns JSON:

```json
{
  "url": "https://drive.google.com/file/d/1AbC…/view",
  "driveFileId": "1AbC…",
  "fileName": "board-deck.pptx",
  "bytes": 812344,
  "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "sharing": "private-shared-with-caller",
  "sharedWith": "jsmith@psd401.net",
  "ownedBy": "agnt_jsmith@psd401.net",
  "expires": "never"
}
```

The file is created in **your own agent Drive account** and shared with **one
person: the user who asked**, as a writer. Nobody else can open it. Ownership
stays with your account — the user can edit, copy and download it, and it does
not count against their Drive quota.

## The decision: Drive or public

Ask one question: **would you hand this file to a stranger who found the URL?**

| | Use |
|---|---|
| Student records, IEPs, personnel files, rosters, anything FERPA-covered | **Drive** (default) |
| Anything with a named individual's data in it | **Drive** (default) |
| An internal draft, a report for one person, a working document | **Drive** (default) |
| A public flyer, a published agenda, a board packet already public, a chart | `--to public` |

When in doubt, Drive. It is the default precisely because the opposite default
was wrong: for a long time a public link was the *only* outbound path, so files
full of student and staff data went onto public URLs because nothing else
existed.

`publish.js` cannot make this judgement for you — it checks size and extension,
never contents.

## What you can deliver

**To Drive (default):** `.pdf` `.docx` `.xlsx` `.pptx` `.csv` `.md` `.txt`
`.png` `.jpg` `.jpeg` `.webp`

**To a public link (`--to public`):** `.pdf` `.png` `.jpg` `.jpeg` `.webp`
`.svg` `.csv` `.json` `.md` `.txt` `.mp3` `.mp4`

Maximum 100 MB either way. Anything else is refused by name, and the error says
whether the other destination accepts it.

**Word, Excel and PowerPoint can ONLY go to Drive.** There is no public path for
them, and that is deliberate: an Office file belongs somewhere it opens in
place and keeps its format. Do not convert a deck to PDF just to get a link —
deliver the `.pptx` to Drive.

**`.html` is on neither list, deliberately.** An HTML page is a district
document, so it goes to Atrium — where it gets an owner, a visibility level and
a publication record. Use `psd-html-artifact/deliver.js` for those. This skill
will tell you so if you try.

## The public link, if you use one

```bash
node /opt/psd-skills/psd-publish-file/publish.js --file /tmp/flyer.pdf --to public
```

Say this out loud in your reply when you use it, because both halves matter:

- The URL is **unsigned and public-by-link**. The UUID makes it unguessable,
  the same model as a Google Drive "anyone with the link" share — unguessable is
  not the same as protected.
- **It expires.** The `expire-public-artifacts` lifecycle rule deletes the
  object **30 days** after it is written, and the link then 404s. If the user
  needs it to last, say so and deliver to Drive instead.

## If the Drive delivery fails

The error carries a machine-readable `code`:

- `share_failed` — the file could not be shared with the user, so they cannot
  see it. **Run the command again.** The unshared copy is cleaned up for you.
  Do **not** fall back to `--to public`; that is the whole thing this path
  exists to avoid. If a retry fails too, tell the user the delivery is broken
  and what the file is.
- `unsupported_type` — the extension is not deliverable. The message lists what
  is. Convert, or use the destination it names.
- `content_type_mismatch` — drop the `--content-type` flag and let the
  extension decide.

## Pasting the link

Put the `url` value **bare, on a line by itself**.

- ✅ Correct:
  ```
  Here's the deck — it's in your Drive:
  https://drive.google.com/file/d/1AbC…/view
  ```
- ❌ Wrong: wrapping it in backticks. A trailing backtick percent-encodes to
  `%60` and the link 404s — this has happened in production more than once.
- ❌ Wrong: `[the deck](url)` or bolding. Chat's renderer corrupts long URLs.
- ❌ Wrong: describing the file without pasting the URL. The user cannot see the
  tool result; if the link is not in your reply, they got nothing.
- ❌ Wrong: saying you have "attached" the file. You cannot attach anything —
  Chat replies carry no attachments. The link is the delivery.

## What this is NOT

- **Not `drive +upload`.** That command looks like it should work and cannot:
  the Workspace CLI runs in an empty temporary directory on the web tier, so a
  container path does not exist there at all. This skill is the route that
  works, and it does put the file in Drive.
- **Not a share with anyone else.** It shares with the caller and no one. If the
  user wants a colleague to have it too, they can share it themselves from
  Drive, or ask you to — `drive permissions create` handles in-district named
  people (see psd-workspace).
- **Not a converter.** Deliver the file as it is. If it is the wrong format,
  convert it first with the appropriate skill, then deliver the result.
- **Not for workspace persistence.** Files in your workspace are already saved
  between turns. Deliver only when someone outside this conversation needs the
  file.
