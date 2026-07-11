---
name: psd-tts
summary: Turn text into a shareable MP3 with Amazon Polly (generative voices) and return a public HTTPS link — narration, briefings, audio summaries.
description: Convert text to natural-sounding speech (MP3) with Amazon Polly and return a shareable HTTPS URL. Use when asked to read something aloud, narrate a document, or make an audio version or podcast of text.
allowed-tools: Bash(/opt/agentcore-venv/bin/python3:*)
---

# psd-tts

Convert text to a natural-sounding MP3 with **Amazon Polly**, upload it to the workspace
S3 bucket under the public `public-images/` prefix, and return an unsigned HTTPS URL the
user can play in any browser (Google Chat renders it as a link). Same delivery model as
`psd-image-gen` and `psd-html-artifact`.

**Identity.** Requires `--user <caller-email>`. Pass the email verbatim from the
`[caller: Name <email>]` header of the user turn (it scopes the S3 upload path).

Polly is a standard AWS service (not Bedrock) authenticated by the execution role — no
API key, no per-character prompt to the model. Long text is split at sentence boundaries
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

Returns JSON: `{ "status": "ok", "url": "...", "s3Key": "public-images/.../<uuid>.mp3", "voice": "Ruth", "engine": "generative", "characters": N, "chunks": N, "sharing": "public-by-link" }`.

## Required Reply Format

After the skill returns `status: ok`, your **next chat message MUST contain the bare `url`
on a line by itself** (Google Chat renders it as a playable/downloadable link). Do not wrap
it in Markdown link syntax or bold — bare URL only. The URL is public-by-link and does not
expire; do not presign or re-upload it.

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

- **`bad_args`** — missing/invalid `--user`, or no text supplied.
- **`too_large`** — text exceeds 200,000 characters.
- **`upstream_error`** — Polly rejected the request (e.g. a voice not offered by the chosen
  engine) or S3/synthesis failed. Check the voice/engine pairing in `references/voices.md`.
- **`misconfigured`** — `WORKSPACE_BUCKET` env var not set.
