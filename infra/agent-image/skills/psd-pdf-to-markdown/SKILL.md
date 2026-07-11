---
name: psd-pdf-to-markdown
summary: Convert a PDF (from a URL, workspace S3 key, or container path) into clean Markdown with tables preserved — no image files, no model download.
description: Convert a PDF to clean Markdown with tables preserved and images dropped. Use when the user wants to turn a PDF into Markdown or extract a PDF's text/tables for further processing. Input is a public URL, a workspace S3 key, or a container file path.
allowed-tools: Bash(python3:*), Bash(/opt/agentcore-venv/bin/python3:*)
---

# psd-pdf-to-markdown

Convert a PDF into clean, well-structured Markdown. Tables become Markdown tables;
images and graphics are dropped (no image files are written). Runs entirely inside the
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

## Output

A single JSON object on stdout:

```json
{ "status": "ok", "source": "...", "output_path": "/tmp/report.md", "chars": 8123, "markdown": "# Report\n..." }
```

- For results **≤ 24,000 chars**, the full Markdown is inlined under `markdown` — use it directly.
- For larger results, only a `preview` is inlined; **Read the `output_path` file** for the full document.

## Notes & limits

- **No OCR in v1.** A scanned / image-only PDF yields little or no text and returns
  `empty_output`. (Amazon Textract is wired elsewhere in the platform and is the future
  fallback for scanned documents.)
- Images are intentionally omitted — this produces pure Markdown text suitable for feeding
  to other tools or summarizing (e.g. pipe into `psd-summarize`).
- Max input size is 100 MB.

## Errors

- **`bad_args`** — missing/invalid input flag, non-PDF file, or a refused `--url`.
- **`forbidden`** — `--url` resolved to a non-public address (SSRF guard), or `--s3-key` was outside the caller's own `public-images/<email>/` prefix.
- **`misconfigured`** — `WORKSPACE_BUCKET` unset for an `--s3-key` request.
- **`upstream_error`** — the URL fetch or S3 download failed.
- **`convert_error`** — the PDF could not be parsed (corrupt or unsupported).
- **`too_large`** — the input exceeds 100 MB.
- **`empty_output`** — no extractable text (likely a scanned PDF needing OCR).
