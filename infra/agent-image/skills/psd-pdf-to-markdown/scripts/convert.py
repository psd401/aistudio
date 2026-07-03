#!/usr/bin/env python3
"""
convert.py — psd-pdf-to-markdown.convert

Convert a PDF to clean Markdown (tables preserved) using pymupdf4llm. Runs
inside the AgentCore container against the pre-installed venv (pymupdf4llm is
baked into /opt/agentcore-venv at image build time), so it is invoked with
`python3`, NOT `uv run` — there is no per-run dependency resolution.

Usage (exactly one input source):
    python3 convert.py --url   https://example.com/report.pdf
    python3 convert.py --s3-key inbox/report.pdf          # workspace bucket
    python3 convert.py --path  /home/node/workspace/report.pdf
  optional:
    --out /tmp/report.md         # default: /tmp/<stem>.md
    --pages "0,5-10"             # 0-based page selection
    --user name@psd401.net       # only used to scope an --s3 upload of large output

Output: a single JSON object on stdout. For small results the full Markdown is
inlined under "markdown"; for large results only a "preview" is inlined and the
agent should Read the "output_path" file.

Design notes:
- No ML model download at runtime (pymupdf4llm ships a small aarch64 wheel).
- No LLM image captioning in v1 — images are dropped (write_images=False) and
  any residual image references are stripped, matching the "pure Markdown text,
  no embedded images" contract.
- --url is SSRF-guarded: only http/https, and the resolved host must not be a
  loopback/link-local/private address. The container holds IAM reach to
  secrets, so a prompt-injected fetch of an internal endpoint is a real risk.
"""

import argparse
import ipaddress
import json
import os
import re
import socket
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

# Inline the full Markdown in the JSON result when it is at or below this size;
# above it, return only a preview + the output_path so a large PDF cannot blow
# up the agent's context in one shot.
INLINE_LIMIT = 24000
PREVIEW_CHARS = 2000
# Cap fetched/opened PDFs so a runaway download can't exhaust container disk.
MAX_PDF_BYTES = 100 * 1024 * 1024

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _valid_email(email):
    """Caller identity used to scope --s3-key access; reject '/' (S3 key sep)."""
    return bool(email) and bool(_EMAIL_RE.match(email)) and "/" not in email


def _fail(message, code="error"):
    print(json.dumps({"status": "error", "error": code, "message": message}))
    sys.exit(1)


def _emit(obj):
    print(json.dumps(obj))


def strip_image_references(markdown: str) -> str:
    """Remove any residual image markup so output is pure text."""
    markdown = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", markdown)  # ![alt](path)
    markdown = re.sub(r"<img[^>]*>", "", markdown)            # <img ...>
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)            # collapse gaps
    return markdown.strip()


def _guard_public_url(url: str) -> None:
    """Reject non-http(s) schemes and hosts that resolve to internal ranges."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        _fail(f"--url must be http(s), got scheme '{parsed.scheme}'", "bad_args")
    host = parsed.hostname
    if not host:
        _fail("--url has no host", "bad_args")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        _fail(f"--url host does not resolve: {host} ({exc})", "bad_args")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_private or ip.is_reserved or ip.is_multicast:
            _fail(f"--url host {host} resolves to a non-public address ({ip}) — refused", "forbidden")


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect hop so a 30x to a loopback/link-local/private/
    metadata host cannot bypass the initial SSRF check."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _guard_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download_url(url: str, dest: Path) -> None:
    _guard_public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": "psd-pdf-to-markdown/1.0"})
    opener = urllib.request.build_opener(_GuardedRedirectHandler)
    try:
        with opener.open(req, timeout=30) as resp:  # noqa: S310 (host guarded initially + per redirect)
            total = 0
            with open(dest, "wb") as fh:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_PDF_BYTES:
                        _fail(f"--url body exceeds {MAX_PDF_BYTES} bytes", "too_large")
                    fh.write(chunk)
    except OSError as exc:
        _fail(f"failed to fetch --url: {exc}", "upstream_error")


def _download_s3(key: str, dest: Path, user_email: str) -> None:
    bucket = os.environ.get("WORKSPACE_BUCKET")
    if not bucket:
        _fail("WORKSPACE_BUCKET env var not set — cannot read --s3-key", "misconfigured")
    # The shared AgentCore execution role can GetObject anywhere in the workspace
    # bucket, so scope --s3-key to the caller's own public-images/<email>/ prefix
    # to prevent reading another user's objects (IDOR). Reject path traversal too.
    norm = key.lstrip("/")
    allowed = f"public-images/{user_email}/"
    if ".." in norm.split("/") or not norm.startswith(allowed):
        _fail(f"--s3-key must be under {allowed} (the caller's own prefix)", "forbidden")
    region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        import boto3  # baked into the container venv
    except ImportError:
        _fail("boto3 not available in the runtime", "misconfigured")
    s3 = boto3.client("s3", region_name=region)
    try:
        s3.download_file(bucket, norm, str(dest))
    except Exception as exc:  # botocore ClientError etc.
        _fail(f"failed to download s3://{bucket}/{norm}: {exc}", "upstream_error")


def parse_pages(spec: str):
    """Parse a 0-based page spec like '0,5-10' into a sorted list of ints."""
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = part.split("-", 1)
            pages.update(range(int(lo), int(hi) + 1))
        else:
            pages.add(int(part))
    return sorted(p for p in pages if p >= 0)


def convert_to_markdown(pdf_path: Path, pages) -> str:
    """The one place the PDF engine is bound — swap here if PyMuPDF ever trips
    the AgentCore overlay-mount snapshotter (fallback: pdfplumber/pypdf)."""
    import pymupdf4llm

    kwargs = {"write_images": False, "embed_images": False}
    if pages:
        kwargs["pages"] = pages
    markdown = pymupdf4llm.to_markdown(str(pdf_path), **kwargs)
    return strip_image_references(markdown)


def main():
    parser = argparse.ArgumentParser(description="Convert a PDF to clean Markdown (tables preserved).")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="Public http(s) URL of the PDF")
    src.add_argument("--s3-key", dest="s3_key", help="Key in the workspace S3 bucket")
    src.add_argument("--path", help="Path to a PDF already in the container/workspace")
    parser.add_argument("--out", help="Output .md path (default: /tmp/<stem>.md)")
    parser.add_argument("--pages", help='0-based page selection, e.g. "0,5-10"')
    parser.add_argument("--user", help="Caller email (reserved for future --s3 upload of large output)")
    args = parser.parse_args()

    try:
        pages = parse_pages(args.pages) if args.pages else None
    except ValueError:
        _fail('--pages must be integers or ranges like "0,5-10"', "bad_args")

    with tempfile.TemporaryDirectory() as tmp:
        # Resolve the input PDF to a local path.
        if args.url:
            local = Path(tmp) / "input.pdf"
            _download_url(args.url, local)
            source = args.url
            stem = Path(urlparse(args.url).path).stem or "document"
        elif args.s3_key:
            if not _valid_email(args.user):
                _fail("--s3-key requires --user (caller email) for access scoping", "bad_args")
            local = Path(tmp) / "input.pdf"
            _download_s3(args.s3_key, local, args.user)
            source = f"s3://{os.environ.get('WORKSPACE_BUCKET', '')}/{args.s3_key}"
            stem = Path(args.s3_key).stem or "document"
        else:
            local = Path(args.path).expanduser()
            if not local.is_file():
                _fail(f"--path not found: {local}", "bad_args")
            if local.stat().st_size > MAX_PDF_BYTES:
                _fail(f"--path exceeds {MAX_PDF_BYTES} bytes", "too_large")
            source = str(local)
            stem = local.stem

        # Validate by content, not just a --path suffix: --url/--s3-key inputs
        # are always named input.pdf, so a suffix check would let non-PDF bytes
        # through. The %PDF- magic header is the uniform gate.
        try:
            with open(local, "rb") as fh:
                if not fh.read(5).startswith(b"%PDF-"):
                    _fail("input is not a PDF (missing %PDF- header)", "bad_args")
        except OSError as exc:
            _fail(f"cannot read input: {exc}", "bad_args")

        try:
            markdown = convert_to_markdown(local, pages)
        except Exception as exc:
            _fail(f"conversion failed: {exc}", "convert_error")

    if not markdown.strip():
        _fail("conversion produced no text (scanned/image-only PDF? OCR is not enabled in v1)", "empty_output")

    out_path = Path(args.out).expanduser() if args.out else Path("/tmp") / f"{stem}.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(markdown, encoding="utf-8")

    result = {
        "status": "ok",
        "source": source,
        "output_path": str(out_path),
        "chars": len(markdown),
    }
    if len(markdown) <= INLINE_LIMIT:
        result["markdown"] = markdown
    else:
        result["preview"] = markdown[:PREVIEW_CHARS]
        result["note"] = f"Markdown is {len(markdown)} chars; read output_path for the full document."
    _emit(result)


if __name__ == "__main__":
    main()
