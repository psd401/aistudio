---
name: psd-learning-page
summary: Turn a document (PDF, Google Doc, or markdown) into a self-contained, WCAG 2.2 AA multi-modal learning page — explainer video + captions, narrated audio + transcript, interactive quiz, summary, and full source — then publish it to Atrium.
description: Turn a document (PDF, Google Doc, or markdown) into an accessible multi-modal learning page — video, audio, interactive quiz, summary, full text — published to Atrium. Use to build a learning page, training page, or tutorial from a policy/document.
allowed-tools: Bash(node:*)
---

# psd-learning-page

Turn a document — a board policy/procedure, a PDF, a Google Doc, or markdown — into **one
self-contained HTML learning page** that teaches the concept through several redundant
modalities (Universal Design for Learning 3.0): an **explainer video** with captions, a
**narrated audio** intro with a transcript, an **interactive quiz** with immediate feedback,
a **bullet summary** with learning targets, and the **full source document**. Then publish
it into **Atrium** (the internal "intranet" reader). One artifact a learner can watch,
listen to, read, and self-test against.

This skill **composes existing skills** — it never re-implements them: `psd-pdf-to-markdown`
and `psd-workspace` (ingest), `psd-tts` (narration), `psd-hyperframes` (video), `psd-atrium`
(publish), and the shared `psd-html-artifact` **WCAG 2.2 AA gate**.

**Identity.** Requires `--user <caller-email>` — pass it verbatim from the
`[caller: Name <email>]` header of the user turn. It scopes the composed skills' S3 paths
and the Google-Docs agent export.

## Invoke

Dry-run (assemble locally, no Atrium; embeds tiny labeled placeholder media so the page is
complete + playable offline):

    node /opt/psd-skills/psd-learning-page/run.js \
      --user <email> --source-file <doc.md> --title "Student Technology" \
      --dry-run --out /tmp/lp.html

Full pipeline (generate real media, then publish to Atrium `intranet`):

    node /opt/psd-skills/psd-learning-page/run.js \
      --user <email> --pdf-url "https://…/policy.pdf" --title "Acceptable Use"

## Inputs

Exactly one source, all normalized to markdown (kept in full for the "read the full
document" section):

| Source | Flag(s) | Via |
|--------|---------|-----|
| markdown / text | `--source-file <path>` · `--text "<s>"` · stdin | read directly |
| PDF | `--pdf-url <https>` · `--pdf-s3-key <key>` · `--pdf-path <path>` | `psd-pdf-to-markdown` |
| Google Doc | `--gdoc-url <https://docs.google.com/document/d/ID/…>` · `--gdoc-id <id>` | `psd-workspace` `drive files export` on `--scope agent` |

**Google Docs sharing.** The doc must be shared with the caller's **agent account**
(`agnt_<uniqname>@psd401.net`, Reader is enough). Only a genuine permission error (Drive
`403`/`404`/consent) yields `gdoc_denied` with the "share it with your agent account"
guidance — relay that verbatim; never tell the user to share it with their own address.
Two *transient* conditions are reported distinctly and must **not** be treated as sharing
problems: `gdoc_provisioning` (the agent account is still being auto-created — try again in
~30 min, nothing to click) and `ingest_failed` from a transport/network blip (just retry).

Optional:

- `--video-url <mp4>` / `--audio-url <mp3>` — supply pre-rendered media (skip generation).
- `--content-json <path>` — agent-authored pedagogy content to override the deterministic
  derivation: `{ "learningTargets": [...], "summary": [...], "quiz": [{ "question", "options":
  [...], "answer": <index>, "rationale" }], "narration": { "script": "…" } }`. **Author this
  from the rubric** in `references/pedagogy-rubric.md` for a real learning page — the built-in
  derivation is a working fallback, not a substitute for good pedagogy.
- `--generate-media` — force real media generation even under `--dry-run`.

## Pipeline

1. **Ingest** the source → markdown.
2. **Derive/accept** learning targets + bullet summary + quiz + narration script (rubric-driven).
3. **Narration** → `psd-tts` (`--engine long-form --voice Ruth`) → an MP3 URL (used both as
   the audio intro and the video's audio track).
4. **Video** → `psd-hyperframes` (author a short composition, pass `--audio-url`) → an MP4 URL.
   Renders synchronously; on failure the page **degrades gracefully** (keeps the other
   modalities + a noted omission).
5. **Assemble** one self-contained WCAG 2.2 AA page: the MP4 with an inlined **WebVTT captions
   track**, the MP3 with a **visible transcript**, the interactive quiz (immediate feedback +
   rationale, keyboard-operable, score, `aria-live`, more-than-color), the summary + targets,
   and the HTML-escaped full source in a collapsible section.
6. **Accessibility gate** — the SAME shared `psd-html-artifact` axe gate runs; the page is
   **never** written or published with critical/serious violations (exit 3).
7. **Publish** → `psd-atrium create-artifact --visibility internal` + `publish --destination
   intranet`. `internal` visibility is required so any authenticated PSD user (staff/student)
   can open the published page — a page left `private` (the create default) is visible only to
   the content-key owner and admins even after publishing. Emits the artifact (id/slug/version)
   and the `/c/{slug}` reader URL.

## Media (dry-run vs. published)

Media is embedded **by URL** (the HTML stays small), not inlined bytes — *except* a bare
`--dry-run` with no supplied URL, which embeds tiny **silent placeholder** clips as data URIs
(labeled "Dry-run preview") so the `<video>`/`<audio>` are real + playable offline. The
**published** page always carries the real generated explainer video + narration.

## Output

- **Success (exit 0):** JSON — dry-run: `{ status, mode:"dry-run", outPath, bytes, modalities,
  omissions, a11y }`; published: `{ status, mode:"published", artifact, publish, readerUrl,
  modalities, omissions, a11y }`.
- **Errors:** `bad_args` (1) · `ingest_failed` / `gdoc_denied` / `gdoc_provisioning` /
  `publish_failed` (2) · `a11y_violations` (3, the assembled page failed the WCAG 2.2 AA gate —
  fix and retry; contrast/reflow are browser-verified, not in this gate).

### Required reply format

When the pipeline publishes, **relay `readerUrl` as a bare URL on its own line** — no markdown
link syntax, no backticks, no surrounding punctuation. Some chat surfaces mangle a URL wrapped
in markdown or adjacent to punctuation.

- ✅ `Here is the learning page:` then, on the next line: `https://…/c/student-technology`
- ❌ `[Open the page](https://…/c/student-technology)` or `` `https://…` `` or a trailing `.`

If `readerUrl` is `null` (the app base URL isn't configured), relay the artifact `slug`/`id`
from `artifact` and say the reader link couldn't be constructed — do not invent a URL.

## Rules

1. **Accessibility is non-negotiable.** These are district web pages (ADA Title II / WCAG 2.2
   AA). The gate blocks publish on critical/serious violations — do not work around it.
2. **Never inject document text.** All source content is HTML-escaped before it reaches the DOM.
3. **Degrade, don't fail.** If video/audio generation fails, still ship the page with the
   remaining modalities and a noted omission.
4. **Publish to `intranet` only** (v1). Other destinations are future work.
