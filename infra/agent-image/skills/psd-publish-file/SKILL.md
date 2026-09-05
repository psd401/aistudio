---
name: psd-publish-file
summary: Turn a file you just generated into a shareable HTTPS link — PDFs, images, CSVs, audio, video. Use when the user asks for a link to a file, or to share, host, or send one.
description: Publish a local file the agent produced (PDF, PNG, JPEG, WEBP, SVG, CSV, JSON, MD, TXT, MP3, MP4) and return a shareable HTTPS URL that anyone with the link can open. Use when the user asks for a link to a generated file, wants a file hosted or shared, or you have written a file to /tmp and need to hand it over. Not for HTML pages — those go to Atrium via psd-html-artifact.
allowed-tools: Bash(node:*)
---

# psd-publish-file

You generated a file. The user needs a link to it. That is the whole skill —
with one thing to decide BEFORE you run the command.

**The link is unsigned, public-by-link, and never expires.** Anyone who has the
URL can open it, with no sign-in. So: would you hand this file to a stranger who
found the URL? A board packet, agenda, chart or recording — yes, publish it. A
student record, an IEP, a personnel file, anything FERPA-covered — **no**, do
not publish it; attach it to the reply or share it through Drive with named
people instead. `publish.js` cannot make this judgement for you: it checks size
and extension, never contents.

```bash
node /opt/psd-skills/psd-publish-file/publish.js --file /tmp/<name>.pdf
```

Returns JSON:

```json
{
  "url": "https://<bucket>.s3.<region>.amazonaws.com/public-images/<uuid>.pdf",
  "s3Key": "public-images/<uuid>.pdf",
  "fileName": "board-packet.pdf",
  "bytes": 812344,
  "contentType": "application/pdf",
  "sharing": "public-by-link"
}
```

## What you can publish

`.pdf` `.png` `.jpg` `.jpeg` `.webp` `.svg` `.csv` `.json` `.md` `.txt` `.mp3` `.mp4`

Maximum 100 MB. Anything else is refused by name, with the full list in the error.

**`.html` is not on that list, deliberately.** An HTML page is a district
document, so it goes to Atrium — where it gets an owner, a visibility level and
a publication record — not to a public-by-link bucket. Use
`psd-html-artifact/deliver.js` for those. This skill will tell you so if you try.

## Sharing model — say this out loud

Restating the rule at the top, because this is the one that matters: the URL is
**unsigned, public-by-link, and does not expire**. The UUID makes it
unguessable, the same model as a Google Drive "anyone with the link" share —
unguessable is not the same as protected.

If you publish something even mildly sensitive, say so in the same message as
the link, so the user knows not to forward it. If it is FERPA-covered, do not
publish it at all — offer the attachment or a named-person Drive share and
explain why in one sentence.

## Pasting the link

Put the `url` value **bare, on a line by itself**.

- ✅ Correct:
  ```
  Here's the packet:
  https://psd-agents-prod.s3.us-east-1.amazonaws.com/public-images/6b1e….pdf
  ```
- ❌ Wrong: wrapping it in backticks. A trailing backtick percent-encodes to
  `%60` and the link 404s — this has happened in production more than once.
- ❌ Wrong: `[the packet](url)` or bolding. Chat's renderer corrupts long URLs.
- ❌ Wrong: describing the file without pasting the URL. The user cannot see the
  tool result; if the link is not in your reply, they got nothing.

## What this is NOT

- **Not a Drive upload.** `drive +upload <path>` looks like it should work and
  cannot: the Workspace CLI runs in an empty temporary directory on the web
  tier, so a container path does not exist there at all. If the user
  specifically wants the file *in Drive* (not just reachable by link), say that
  it has to be uploaded by hand and give them the published link to grab.
- **Not a converter.** Publish the file as it is. If it is the wrong format,
  convert it first with the appropriate skill, then publish the result.
- **Not for workspace persistence.** Files in your workspace are already saved
  between turns. Publish only when someone outside this conversation needs to
  open the file.
