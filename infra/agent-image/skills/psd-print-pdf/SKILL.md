---
name: psd-print-pdf
summary: Turn an HTML page into a real printable PDF — 8.5x11, letter, A4, landscape. Use when asked to save, print, or download a page or artifact as a PDF.
description: Convert a local HTML file into a true PDF using headless Chromium, honouring @page CSS, flexbox, embedded images and web fonts. Use when the user asks to save a page, sign, flyer, report or HTML artifact as a PDF, wants something printable, or asks for an 8.5x11 / letter / A4 version of a page. Produces a local .pdf file; publishing it is a separate step.
allowed-tools: Bash(node:*)
---

# psd-print-pdf

You have an HTML file. The user wants a PDF they can print.

```bash
node /opt/psd-skills/psd-print-pdf/print.js --file /tmp/sign.html --out /tmp/sign.pdf
```

Returns JSON:

```json
{
  "file": "/tmp/sign.pdf",
  "bytes": 20924,
  "pages": 1,
  "pageSize": "letter",
  "landscape": false,
  "sharing": "local-file-not-published"
}
```

## What it renders faithfully

Real headless Chromium, so the PDF matches what a browser prints: `@page` CSS,
flexbox and grid, CSS gradients, embedded `data:` images, web fonts, and
backgrounds. This is the whole point of the skill — the previous fallback
(PyMuPDF) silently dropped every one of those and produced a wrong-sized page
that looked broken to the person who opened it.

**The page's own `@page` CSS wins over `--page-size`.** A page already laid out
for 8.5×11 needs no flags at all.

## Options

| flag | default | notes |
|---|---|---|
| `--page-size` | `letter` | `letter`, `legal`, `tabloid`, `a4`, `a3` |
| `--landscape` | portrait | |
| `--margin-inches` | `0` | 0–3. Zero is right for a full-bleed design |
| `--scale` | `1` | 0.1–2 |
| `--no-background` | backgrounds printed | use for a draft that must not burn ink |

## Limits

- Input HTML: **4 MB**. Large embedded base64 images are the usual cause of
  going over — reference them by public `https` URL instead.
- Output PDF: **4 MB**. Above that, split the document.

## After it runs

The PDF is a **local file and nothing else**. It is not shared, not published,
and not reachable by a link.

- If the user wants to keep or print it, say where it is and stop.
- If the user wants a **link**, publish it deliberately with
  `psd-publish-file`, which will make you decide whether the contents are safe
  for an unguessable public URL. A staff flyer, yes. A student record, no.
- Do not paste the local path as if it were a URL.

## Working with psd-html-artifact

The natural pairing: `psd-html-artifact` for the design, this for the print
copy. Build the page first, write it to `/tmp`, then print it.

Note that `psd-html-artifact` publishes to Atrium and returns a reader URL,
which is a different deliverable — a page to read online, not a file to print.
When someone asks for both, do both; they are not substitutes.

## Errors

| `error` | meaning |
|---|---|
| `bad_args` | a flag is missing, unparseable, or out of range — the message names which |
| `too_large` | input HTML or output PDF over the 4 MB limit |
| `render_failed` | Chromium could not render the page; the message carries its diagnostic |

A failure here is worth reporting plainly. Do **not** fall back to telling the
user to print the page themselves — that is the exact dead end this skill
replaced.
