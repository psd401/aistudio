---
name: psd-sop-creator
summary: Turn a procedure — described in chat, or carried over from a PDF, a Google Doc, or an existing Atrium document — into a Peninsula School District Standard Operating Procedure, filed in Atrium as an editable private draft with the official template, letterhead, and any source screenshots preserved.
description: Create a PSD Standard Operating Procedure (SOP) following the official district Standard Operations Template. Use when someone asks to write, draft, document, or convert a procedure, process, or operational guide for Peninsula School District — including "turn this PDF/Google Doc into an SOP" and "write an SOP for X". Interviews for the required details, drafts to the template, validates the structure, and creates it in Atrium as an EDITABLE document (kind=document, markdown) that is PRIVATE and in DRAFT status. Images and screenshots from the source are carried over as real images, not descriptions. It never publishes and never widens visibility.
allowed-tools: Bash(node:*)
---

# psd-sop-creator

Produces a Peninsula School District **Standard Operating Procedure** and files
it in **Atrium** (AI Studio's collaborative content workspace) as an editable
markdown **document**.

An SOP is a living document that staff revise. That is why this creates a
`kind=document`, not an HTML artifact — an artifact would be a snapshot nobody
can edit.

**What it produces:** one Atrium document, **private**, **draft**, in the
`standard-operating-procedures` collection, owned by you (the signed workspace
owner), with the district letterhead and the template's seven sections.

**What it never does:** publish, widen visibility, or route for approval. Review
is a human step. Say so when you hand back the link.

## Workflow

### 1. Get the source

Ingest is a **separate skill invocation** you make first — this skill does not
run the converters itself, so each one applies its own tool permissions. Save
the result to a file and pass it to `create --body-file`.

| Source | Invoke |
|--------|--------|
| The user describes it in chat | Nothing — use what they said; interview for the rest |
| A PDF | the **`psd-pdf-to-markdown`** skill, with **`--extract-images <dir>`** |
| A Google Doc | the **`psd-workspace`** skill (Drive export) |
| An existing Atrium document | the **`psd-atrium`** skill: `read-source --id <id>` — **not** `read`, which never returns a document's text |

For a PDF, always pass `--extract-images` and then point `create --image-base`
at that directory. Without it the screenshots are dropped, and a Technology or
Finance procedure without its screenshots has lost most of its value.

### 2. Interview for what is missing

Read `references/writing-guide.md` and work its rounds. Do not ask all sixteen
questions at once; stop when you have enough.

Three things are **required** and have no sensible default. Ask for them:

- **Owner** — the person or role who owns the procedure.
- **Department** — one of the eight in `references/template.md`.
- **Effective date** — `YYYY-MM-DD`.

Never invent an owner, a date, a policy number, or an RCW citation. If a fact is
missing and the user cannot supply it, write `[NEEDS INPUT: what is missing]` in
the draft so the gap stays visible.

### 3. Draft

Read `references/template.md` for the exact skeleton and
`references/writing-guide.md` for voice and depth.

Write **only the body, starting at `## Title`**. The skill injects the logo, the
`# Standard Operating Procedure (SOP)` heading, and the metadata block — a body
that brings its own gets rejected for duplicating them.

Markdown only. No raw HTML: Atrium's editor-seeding path drops raw HTML tokens
**silently**, so a `<table>` or `<br>` you write simply disappears. Pipe tables,
headings, lists, bold, and links all work.

### 4. Validate while you draft

```bash
node /opt/psd-skills/psd-sop-creator/run.js validate --body-file /tmp/sop.md
```

Free and offline. **Exit 3** returns a structured `violations` list, each with a
`fix`. Apply them and run again. Exit 3 is a to-do list, not a dead end.

### 5. Create

```bash
node /opt/psd-skills/psd-sop-creator/run.js create \
  --body-file /tmp/sop.md \
  --owner "Director of Technology" \
  --department "Technology" \
  --effective-date 2026-08-01 \
  --image-base /tmp/sop-images
```

Then give the user the returned URL **as a bare URL on its own line**, and tell
them it is a private draft.

## Images

Images from the source must be **carried over as images**. Describing a
screenshot in prose instead is a silent downgrade of the document.

Reference each image on **its own line** — an image sharing a line with prose
splits that paragraph around it and breaks the sentence. Three forms are
handled:

| In your body | What happens |
|--------------|--------------|
| `![alt](/tmp/imgs/panel.png)` | Uploaded to the new document as an asset |
| `![alt](relative/panel.png)` | Same, resolved against `--image-base` |
| `![alt](https://…/x.png)` | Kept as-is; already hosted |
| `::atrium-asset{id="…" alt="…"}` | Copied from `--source-id`'s object (see below) |

`data:` URIs do not work — they are stripped. Save the bytes to a file instead.

**Copying an image out of another Atrium document** needs `--source-id <that
document's id>`. An Atrium asset belongs to exactly one object, and a version
referencing an asset its object does not own is rejected — so the bytes are
downloaded from the source and re-uploaded to the new SOP. Without
`--source-id` the skill stops and tells you, rather than producing a document
with broken images.

Give every image real alt text describing what it shows.

## Flags

`validate`: `--body <md>` or `--body-file <path>`.

`create`: the same, plus

| Flag | |
|------|---|
| `--owner <name-or-role>` | required |
| `--department <dept>` | required; one of the eight |
| `--effective-date YYYY-MM-DD` | required |
| `--title <t>` | defaults to the `## Title` section's text |
| `--collection <slug>` | defaults to `standard-operating-procedures` |
| `--tags a,b` | |
| `--image-base <dir>` | resolves relative image paths (defaults to CWD) |
| `--source-id <atriumId>` | the object to copy `::atrium-asset` images from |

## Exit codes

| Code | Meaning | What to do |
|------|---------|-----------|
| 0 | Success | Relay the URL; say it is a private draft |
| 1 | Bad arguments / a referenced image file is missing | Fix the invocation |
| 2 | Internal error | Report it; do not retry blindly |
| 3 | **Template violations** | Read `violations[]`, apply each `fix`, run again |
| 12 | Upstream failure (Atrium, storage) | Surface the error verbatim |

## Rules

1. **Never publish and never widen visibility.** The SOP is created private and
   draft on purpose. Publication is a human decision made after review.
2. **Never invent facts.** No made-up owners, dates, policy numbers, or
   citations. Use `[NEEDS INPUT: …]`.
3. **Carry images over.** A screenshot in the source becomes a screenshot in the
   SOP, not a sentence about a screenshot.
4. **Markdown only.** Raw HTML is dropped without an error.
5. **Roles, not names**, in the procedure body. Roles outlive people.
6. **Exit 3 means keep going.** Fix the listed violations and retry; do not
   report the SOP as impossible.
7. **The document is yours.** It is created as, owned by, and gated on the signed
   workspace owner — not a shared service account.
