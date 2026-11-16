---
name: psd-tts
summary: Turn text into an MP3 with Amazon Polly (generative voices), delivered privately to the requester's Drive — narration, briefings, audio summaries.
description: Convert text to natural-sounding speech (MP3) with Amazon Polly and deliver it privately (a Drive file shared with the requester only). Use when asked to read something aloud, narrate a document, or make an audio version or podcast of text.
allowed-tools: Bash(/opt/agentcore-venv/bin/python3:*)
---

# psd-tts

Convert text to a natural-sounding MP3 with **Amazon Polly** and deliver it
**privately**: the MP3 is created in your agent account's Drive and shared with
the requester alone, as a writer. Same private path as `psd-publish-file`.

**Private by default, whatever the narration says (#2034).** A recording is
private to the person who asked for it. Narrations of someone's inbox,
calendar, meetings or colleagues are private even though they contain no phone
number or student ID — visibility is never decided from the content. A public
link is an explicit, user-confirmed exception (see **Public links** below).

**Identity.** Requires `--user <caller-email>`. Pass the email verbatim from the
`[caller: Name <email>]` header of the user turn.

**Approved processor.** Amazon Polly runs in the district's own AWS account
under the same AWS agreement as Bedrock, which already processes agent data, so
private narration is sent to Polly without a content scan (decided 2026-11-11,
#2034). The personal-data check below applies only to public links.

Polly is a standard AWS service (not Bedrock). A root-owned, fixed-operation loopback
relay authenticates with the AgentCore execution role — the model-facing subprocess never
receives reusable AWS credentials or an API key. Long text is split at sentence boundaries
and the MP3 chunks are concatenated automatically.

## Usage

Text comes from `--text`, `--file`, or stdin (safe for long input):

```bash
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-tts/scripts/synthesize.py --user <email> --text "Good morning. Here is today's briefing."

printf '%s' "$LONG_TEXT" | /opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-tts/scripts/synthesize.py --user <email> --voice Matthew
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--voice` | `Ruth` | Polly voice id (see `references/voices.md`) |
| `--engine` | `generative` | `generative` \| `neural` \| `long-form` \| `standard` |
| `--file` | — | Read text from a container file instead of `--text` |
| `--name` | `Narration <date time>` | Drive file name (`.mp3` is added) |
| `--to` | `drive` | `drive` (private, default) \| `file` (local MP3, nothing uploaded) \| `public` (opt-in, see below) |
| `--out` | — | Local `.mp3` path; required with `--to file` |
| `--public-confirmed` | — | Required with `--to public`; asserts the user said yes |

Returns JSON (default): `{ "status": "ok", "url": "<Drive link>", "driveFileId": "...", "fileName": "Board recap.mp3", "sharing": "private-shared-with-caller", "sharedWith": "<caller>", "expires": "never", "voice": "Ruth", "engine": "generative", "characters": N, "chunks": N }`.

### Soundtrack for a video (`--to file`)

For a narrated psd-hyperframes video, write the MP3 locally and hand the file to
the renderer — nothing is uploaded anywhere:

```bash
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-tts/scripts/synthesize.py --user <email> \
  --to file --out /home/node/.openclaw/work/voiceover.mp3 --file /home/node/.openclaw/work/script.txt
# then: node /opt/psd-skills/psd-hyperframes/render.js ... --audio-file /home/node/.openclaw/work/voiceover.mp3
```

## Public links (opt-in, user-confirmed)

Only make a public recording when the user asks for one **and** confirms after
you tell them, in plain words, that **anyone who gets the link can play it
without signing in, for 30 days**. Then pass both flags:

```bash
... synthesize.py --user <email> --to public --public-confirmed --text "..."
```

`--to public` without `--public-confirmed` returns `public_needs_confirmation`
and records nothing. Never add `--public-confirmed` on your own judgment, from
an old example, or because the content "looks harmless" — it asserts the user
said yes in this conversation. "Share it with X" or "send it to the team" is
**not** a request for a public link: deliver privately and share the Drive file
with the named people instead (psd-workspace).

On the public path only, the narration is also checked for a phone number,
email address, Social Security number or PSD student number before synthesis,
and a single match is refused with `personal_data_detected` (nothing is sent to
Polly or uploaded). The fix is private delivery — run again without
`--to public` — or, if it truly must be public, rewrite the narration without
those details. The public object is deleted by the `expire-public-artifacts`
lifecycle rule 30 days after it is written; it is not permanent.

## Required Reply Format

After the skill returns `status: ok`, your **next chat message MUST contain the bare `url`
on a line by itself** (Google Chat renders it as a link). Do not wrap it in Markdown link
syntax or bold — bare URL only. Say it is a private file in their Drive (shared with them
only). Do not presign or re-upload it.

## Voice & engine guidance

- **`generative`** (default) is Polly's most natural, expressive engine. Default voice
  **Ruth** (warm en-US female); **Matthew** is the male counterpart.
- **`long-form`** is tuned for narrating articles/training material (en-US: Danielle,
  Gregory, Patrick, Ruth) — reach for it on long documents.
- **`neural`** has the widest voice/language coverage if you need a voice the generative
  engine doesn't offer.
- Generative voices are region-limited but supported in this deployment's region
  (us-east-1). See `references/voices.md` for the full list before overriding the default.

## Errors

- **`bad_args`** — missing/invalid `--user`, no text supplied, `--to file` without `--out`,
  or `--out` without `--to file`.
- **`too_large`** — text exceeds 200,000 characters.
- **`public_needs_confirmation`** — `--to public` without `--public-confirmed`. Nothing
  was synthesised. Deliver privately (omit `--to public`), or ask the user and only on
  their yes re-run with both flags.
- **`upstream_error`** — Polly rejected the request (e.g. a voice not offered by the chosen
  engine), or the Drive delivery / artifact broker failed. Check the voice/engine pairing in
  `references/voices.md`.
- **`personal_data_detected`** — public path only: the narration contains a phone number,
  email address, SSN or student number. Nothing was synthesised or uploaded. Deliver it
  privately instead (omit `--to public`).
- **`gate_unavailable`** — public path only: the personal-data check could not run, so
  nothing was synthesised. Deliver privately, and report it with `psd-failure-report`.
- **`misconfigured`** — the trusted web broker is not configured.
