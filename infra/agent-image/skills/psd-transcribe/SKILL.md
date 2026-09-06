---
name: psd-transcribe
summary: Turn a recording into text — transcribe audio or video into a transcript, script, or notes. Handles m4a, mp3, mp4, wav and more.
description: Transcribe speech from an audio or video file into text using Amazon Transcribe. Use when the user shares a recording, voice memo, meeting audio, podcast, or video and asks for a transcript, a script, notes, a summary of what was said, or asks what is in the recording. Accepts .m4a, .mp3, .mp4, .wav, .flac, .ogg, .amr and .webm; other formats convert first with psd-media.
allowed-tools: Bash(node:*)
---

# psd-transcribe

Speech in a file, text out.

```bash
node /opt/psd-skills/psd-transcribe/transcribe.js --file /tmp/recording.m4a
```

Returns JSON with the transcript inline:

```json
{ "transcript": "Starting our week off strong…", "characters": 4820,
  "truncated": false, "language": "en-US" }
```

Add `--out /tmp/transcript.txt` to also write it to a file — useful when the
next step is turning it into a document rather than reading it in chat.

## Accepted formats

`.m4a` `.mp3` `.mp4` `.wav` `.flac` `.ogg` `.amr` `.webm`

Anything else — `.aiff`, `.wma`, an odd container — convert first:

```bash
node /opt/psd-skills/psd-media/media.js --convert --file /tmp/odd.aiff \
  --out /tmp/audio.mp3 --preset audio-mp3
```

Video works directly; there is no need to strip the audio yourself.

## Language

Defaults to `en-US`. Pass `--language es-US` (or any `xx-XX` code) when the
recording is not English. Getting this wrong produces confident nonsense rather
than an error, so if a user mentions the recording is in another language, set
it.

## Limits

- Input: **512 MB**.
- Transcription must finish inside the turn. A short recording is quick; an
  hour-long one is close to the ceiling — if it times out, say so plainly.
- Transcript: 600k characters, then truncated with `truncated: true`. Report
  that honestly rather than presenting a partial transcript as complete.

## What to do with the result

The transcript is **raw**: no speaker labels, punctuation from the recogniser,
and verbatim filler. That is usually not what the user wants as a deliverable.

- Asked for a **script** or **notes** — clean it up and structure it yourself.
  That is your work, not the recogniser's.
- Asked for a **printable** version — write the cleaned text to HTML and use
  `psd-print-pdf`.
- Asked for the **exact words** — hand back the transcript as-is and say it is
  unedited.

## Privacy

A recording is someone's voice, and often a meeting they did not expect to be
republished. The transport copy is deleted after transcription, and nothing here
publishes anything. Do not publish the audio or the transcript with
`psd-publish-file` unless the user explicitly asks — an unguessable public link
is still a public link.

## Errors

| `error` | meaning |
|---|---|
| `bad_args` | unsupported extension (the message gives the conversion command) or a bad `--language` |
| `too_large` | over 512 MB |
| `empty_transcript` | no speech detected — check the file has audible speech and the language matches |
| `transcribe_failed` | the job failed or timed out; the message carries the reason |
