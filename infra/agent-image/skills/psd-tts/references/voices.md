# Amazon Polly voices & engines

`--engine` selects the model; `--voice` must be a voice that engine offers. Pairing a
voice with an engine it doesn't support returns `upstream_error`. Default is
`--engine generative --voice Ruth`.

## generative (default — most natural, expressive)

Polly's largest TTS model; best for conversational and narration use. Region-limited but
available in this deployment's region (us-east-1).

en-US: **Danielle, Joanna, Matthew, Ruth, Salli, Stephen, Tiffany**
en-GB: Amy, Brian · plus Aria (NZ), Jasmine (SG), Kajal (IN), Niamh (IE), Ayanda (ZA)

Recommended defaults:
- **Ruth** — warm en-US female (skill default)
- **Matthew** — clear en-US male
- **Danielle** / **Joanna** — alternate en-US female
- **Stephen** — alternate en-US male

## long-form (tuned for narrating articles / training material)

en-US only: **Danielle, Gregory, Patrick, Ruth**

Use for reading long documents aloud when you want a steady narration tone rather than the
generative engine's more conversational expressiveness.

## neural (widest coverage, solid mid-tier)

Broadest voice/language selection. Includes en-US Matthew, Joanna, Ruth, Stephen, Kevin,
Kimberly, Salli, Joey, and many non-English voices. Use when you need a voice or language
the generative engine doesn't offer.

## standard (legacy)

The original, least natural engine. Avoid unless a specific legacy voice is required.

## Notes

- `OutputFormat` is fixed to `mp3` at 24 kHz in this skill.
- Character limits per synthesize call: 6,000 total / 3,000 billable. The skill chunks
  longer text at sentence boundaries (~2,800 chars/chunk) and concatenates the MP3s.
- SSML is not exposed in v1; input is treated as plain text.
