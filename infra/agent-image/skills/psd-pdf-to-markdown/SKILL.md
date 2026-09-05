---
name: psd-pdf-to-markdown
summary: Convert a PDF (from a URL, workspace S3 key, or container path) into clean Markdown with tables preserved — text-only by default, embedded images extracted on request, and scanned/image-only PDFs rendered to page images you can read. No model download.
description: Convert a PDF to clean Markdown with tables preserved. Images are dropped by default; pass --extract-images DIR to write them out as PNGs and keep their references, which is what you want when the images must survive into whatever you build next. Use when the user wants to turn a PDF into Markdown or extract a PDF's text/tables/figures for further processing. A scanned/image-only PDF has no text to extract: pass --rasterize-pages DIR to render the pages as PNGs and read them directly (no OCR engine needed). Input is a public URL, a workspace S3 key, or a container file path.
allowed-tools: Bash(/opt/agentcore-venv/bin/python3:*)
---

# psd-pdf-to-markdown

Convert a PDF into clean, well-structured Markdown. Tables become Markdown tables;
images and graphics are dropped unless you ask for them with `--extract-images`. Runs entirely inside the
container against the pre-installed `pymupdf4llm` engine — there is **no ML model download
at runtime** and no external API key.

## Input: there is no chat file-upload path

The agent harness cannot receive a file a user drops into chat. Provide the PDF one of
three ways (exactly one):

| Flag | Source | Use when |
|------|--------|----------|
| `--url <https>` | A public http(s) URL | The user pasted or linked a PDF URL |
| `--s3-key <key>` | The caller's own `public-images/<email>/` prefix (requires `--user`) | The PDF is in the caller's workspace prefix |
| `--path <path>` | A file already in the container/workspace | Another step already fetched the PDF |

`--url` is SSRF-guarded: only http/https, and the host must resolve to a public address
(loopback/link-local/private/metadata targets are refused; redirects are re-validated).
`--s3-key` is scoped to the caller's own `public-images/<email>/` namespace (so it requires
`--user` and cannot read another user's objects). Input is validated by the `%PDF-` magic
header regardless of source.

## Usage

```bash
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-pdf-to-markdown/scripts/convert.py --url "https://example.com/report.pdf"
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-pdf-to-markdown/scripts/convert.py --user <email> --s3-key "public-images/<email>/report.pdf"
/opt/agentcore-venv/bin/python3 /opt/psd-skills/psd-pdf-to-markdown/scripts/convert.py --path "/home/node/workspace/report.pdf"
```

Options:

| Flag | Description |
|------|-------------|
| `--out <path>` | Output `.md` path (default `/tmp/<stem>.md`) |
| `--pages "0,5-10"` | Convert specific **0-based** pages only |
| `--extract-images <dir>` | Write embedded images into `<dir>` as PNGs and **keep** their `![](abs/path)` references in the Markdown. The directory must be empty. Capped at 50 images. |
| `--rasterize-pages <dir>` | Render whole **pages** into `<dir>` as PNGs (150 DPI). The answer for a scanned PDF — read the images. Empty directory, different from `--extract-images`. Capped at 30 pages. |

## Output

A single JSON object on stdout:

```json
{ "status": "ok", "source": "...", "output_path": "/tmp/report.md", "chars": 8123, "markdown": "# Report\n..." }
```

- For results **≤ 24,000 chars**, the full Markdown is inlined under `markdown` — use it directly.
- For larger results, only a `preview` is inlined; **Read the `output_path` file** for the full document.

With `--extract-images` the result also carries `image_dir` and an `images` array of
**absolute** paths, and the Markdown keeps an `![alt](/abs/path.png)` reference for each
one. (References are absolutized on purpose — a relative path would only resolve from the
CWD this converter ran in, not from yours.) If the PDF held more than 50 images the extra
files are deleted and `images_dropped` + `image_note` say so, so you never silently ship a
document whose image links point at nothing.

Use `--extract-images` whenever the pictures matter downstream — a procedure's screenshots
belong in the document you build, not summarized as "a screenshot of the control panel".

## Scanned PDFs — read the pages, don't give up

A scan is a photograph of paper: it has no text layer, so there is nothing to extract
and Markdown conversion returns nothing. That is not a broken document and it is not a
dead end.

**There is no OCR engine in the agent runtime, and you do not need one — you can read
images.** Render the pages and read them:

```bash
python3 /opt/psd-skills/psd-pdf-to-markdown/scripts/convert.py \
  --path /tmp/scan.pdf --rasterize-pages /tmp/pdf-pages
```

The result carries `pages_rendered` (absolute PNG paths, one per page, 150 DPI) plus
`text_layer: "none"`. **Read those images and answer the question from them.** Do not
report that the PDF could not be processed — one caller was told exactly that about a
scanned PDF, and the turn ended there with nothing delivered.

`--rasterize-pages` also works alongside a normal conversion, when you want both the
extracted text and a look at the actual page layout. It must be a different, empty
directory from `--extract-images`.

Bounded at 30 pages. For a longer scan, narrow it with `--pages` (e.g. `--pages 0-9`)
and work through it in batches.

**Why rendering beats `--extract-images` for a scan:** a scanned page's embedded raster
may be tiled into strips, inverted, CMYK, or absent entirely. Rendering the page always
produces exactly what a human would see.

## Notes & limits

- **No OCR engine.** See "Scanned PDFs" above — the working route is `--rasterize-pages`
  plus your own reading, not an OCR pass. (Amazon Textract remains a possible future
  addition for bulk, unattended extraction.)
- Images are intentionally omitted — this produces pure Markdown text suitable for feeding
  to other tools or summarizing (e.g. pipe into `psd-summarize`).
- Max input size is 100 MB.

## Errors

- **`bad_args`** — missing/invalid input flag, non-PDF file, or a refused `--url`.
- **`forbidden`** — `--url` resolved to a non-public address (SSRF guard), or
  an artifact key was outside the signed caller's public prefix.
- **`misconfigured`** — the trusted artifact broker is unavailable.
- **`upstream_error`** — the URL fetch or brokered artifact download failed.
- **`convert_error`** — the PDF could not be parsed (corrupt or unsupported).
- **`too_large`** — the input exceeds 100 MB.
- **`scanned_pdf`** — no extractable text because the PDF is a scan. The message reports
  how many pages carry text and gives the exact `--rasterize-pages` command to re-run.
  This is a routing instruction, not a failure to relay: follow it.
