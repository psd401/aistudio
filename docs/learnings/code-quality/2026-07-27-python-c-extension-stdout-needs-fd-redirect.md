---
title: contextlib.redirect_stdout does NOT silence a C extension — dup fd 2 over fd 1 instead
category: code-quality
tags:
  - python
  - stdout
  - json-contract
  - pymupdf
  - cli
  - agent-skills
severity: medium
date: 2026-07-27
source: auto — /lfg psd-sop-creator
applicable_to: project
---

## What Happened

`infra/agent-image/skills/psd-pdf-to-markdown/scripts/convert.py` documents a
strict contract: **a single JSON object on stdout**. It had been violating that
contract since it was written. `pymupdf4llm`/PyMuPDF print progress lines —
`=== Document parser messages ===`, `Using Tesseract for OCR processing.`,
`OCR on page.number=0/1.` — directly to stdout, so a caller doing
`json.load(proc.stdout)` got a `JSONDecodeError`, not a result.

Nobody noticed because the one existing consumer (`psd-learning-page`) parses
with a `lastJson()` helper that scans for a trailing JSON block and therefore
skips right past the preamble. The contract was broken; the workaround hid it.

## Root Cause

The first fix attempt was the obvious one:

```python
with contextlib.redirect_stdout(sys.stderr):
    markdown = pymupdf4llm.to_markdown(...)
```

**It did nothing.** `contextlib.redirect_stdout` rebinds the Python-level
`sys.stdout` object. The noise does not come from Python — it comes from the
compiled extension module writing to **file descriptor 1** directly, which
never consults `sys.stdout`. Verified empirically: after adding the redirect,
stdout still carried the preamble and stderr was empty.

## Solution

Redirect at the file-descriptor level, and restore in a `finally`:

```python
@contextlib.contextmanager
def _stdout_to_stderr():
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)                              # fd 1 -> stderr
        with contextlib.redirect_stdout(sys.stderr):  # also catch Python-level writes
            yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)
```

Both layers are needed: `dup2` catches the extension, `redirect_stdout` catches
any Python-level printing in the same call.

## How To Verify

Do not eyeball the terminal — a terminal shows fd 1 and fd 2 interleaved, so a
broken redirect looks identical to a working one. Separate the streams and
parse:

```bash
python3 convert.py --path in.pdf 2>/dev/null > out.json
python3 -c "import json; json.load(open('out.json'))"   # must not raise
```

## Prevention

- Any CLI whose contract is "JSON on stdout" and which calls into a C/C++
  extension (PyMuPDF, OpenCV, TensorFlow, gRPC, …) needs the fd-level guard.
  Assume compiled dependencies will print.
- A permissive parser on the consuming side (a "find the trailing JSON block"
  scanner) **hides** this class of bug indefinitely. When you add such a helper,
  treat every input that needs it as a producer-side defect to be fixed, not a
  quirk to be tolerated.
- Test the contract with a strict parse against a separated stream, not by
  reading the console.
