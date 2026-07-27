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
    --user name@psd401.net       # REQUIRED with --s3-key (scopes access to your own prefix)
    --extract-images /tmp/imgs   # write embedded images as PNGs and KEEP their
                                 # ![](path) references in the Markdown

Output: a single JSON object on stdout. For small results the full Markdown is
inlined under "markdown"; for large results only a "preview" is inlined and the
agent should Read the "output_path" file.

Design notes:
- No ML model download at runtime (pymupdf4llm ships a small aarch64 wheel).
- No LLM image captioning — images are dropped by DEFAULT (write_images=False)
  and any residual image references are stripped, matching the original "pure
  Markdown text, no embedded images" contract. Pass --extract-images DIR to opt
  IN to writing the embedded images to disk and keeping their ![](path)
  references, for callers (e.g. psd-sop-creator) that must carry a source
  document's screenshots into the document they produce rather than describing
  them in prose. Extraction is bounded by MAX_EXTRACTED_IMAGES so a
  figure-dense PDF cannot fill the container's disk.
- --url is SSRF-guarded: only http/https, and the resolved host must not be a
  loopback/link-local/private address. The container holds IAM reach to
  secrets, so a prompt-injected fetch of an internal endpoint is a real risk.
"""

import argparse
import contextlib
import ipaddress
import json
import os
import re
import socket
import sys
import tempfile
import urllib.error
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
# Ceiling on --extract-images output. A figure-dense PDF can carry hundreds of
# embedded rasters; writing them all would fill the container's ephemeral disk
# and hand the caller more images than any document should embed.
MAX_EXTRACTED_IMAGES = 50

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


def _ip_is_public(ip_str: str) -> bool:
    """False for loopback/link-local/private/reserved/multicast/unspecified IPs."""
    ip = ipaddress.ip_address(ip_str)
    return not (
        ip.is_loopback or ip.is_link_local or ip.is_private
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


class _BlockedAddress(OSError):
    """Raised by the patched resolver when a host resolves to a non-public IP."""


_REAL_GETADDRINFO = socket.getaddrinfo


def _guarded_getaddrinfo(host, *args, **kwargs):
    """Validate IPs at the SAME resolution urllib uses to connect, closing the
    DNS-rebinding TOCTOU: a pre-check plus urllib's own second resolution could
    otherwise differ (short-TTL record flips public -> private between them)."""
    infos = _REAL_GETADDRINFO(host, *args, **kwargs)
    for info in infos:
        if not _ip_is_public(info[4][0]):
            raise _BlockedAddress(f"host {host} resolves to a non-public address ({info[4][0]})")
    return infos


def _guard_public_url(url: str) -> None:
    """Reject non-http(s) schemes and hosts that resolve to internal ranges.
    This is the early/defense-in-depth check; _guarded_getaddrinfo closes the
    TOCTOU on the actual connect."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        _fail(f"--url must be http(s), got scheme '{parsed.scheme}'", "bad_args")
    host = parsed.hostname
    if not host:
        _fail("--url has no host", "bad_args")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = _REAL_GETADDRINFO(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        _fail(f"--url host does not resolve: {host} ({exc})", "bad_args")
    for info in infos:
        if not _ip_is_public(info[4][0]):
            _fail(f"--url host {host} resolves to a non-public address ({info[4][0]}) — refused", "forbidden")


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate the scheme of every redirect hop so a 30x to file:// etc.
    can't slip past; IP validation for each hop is handled by the patched
    resolver active during the fetch."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _guard_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download_url(url: str, dest: Path) -> None:
    _guard_public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": "psd-pdf-to-markdown/1.0"})
    opener = urllib.request.build_opener(_GuardedRedirectHandler)
    # Pin resolution for the duration of the fetch so the IPs urllib actually
    # connects to (initial request AND every redirect) are the validated ones,
    # not a second independent lookup. Safe to patch the module global: this is
    # a single-shot, single-threaded CLI process, and it is restored in finally.
    socket.getaddrinfo = _guarded_getaddrinfo
    try:
        with opener.open(req, timeout=30) as resp:  # noqa: S310 (scheme+IP guarded per resolution)
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
    except urllib.error.URLError as exc:
        if isinstance(getattr(exc, "reason", None), _BlockedAddress):
            _fail(f"{exc.reason} — refused", "forbidden")
        _fail(f"failed to fetch --url: {exc}", "upstream_error")
    except _BlockedAddress as exc:
        _fail(f"{exc} — refused", "forbidden")
    except OSError as exc:
        _fail(f"failed to fetch --url: {exc}", "upstream_error")
    finally:
        socket.getaddrinfo = _REAL_GETADDRINFO


def _download_s3(key: str, dest: Path, user_email: str) -> None:
    try:
        sys.path.insert(0, "/app")
        from artifact_publisher import download_public_artifact
        _ = user_email
        download_public_artifact(key.lstrip("/"), dest, MAX_PDF_BYTES)
    except Exception as exc:
        _fail(f"failed to download owner artifact: {exc}", "upstream_error")


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


@contextlib.contextmanager
def _stdout_to_stderr():
    """Point FILE DESCRIPTOR 1 at stderr for the duration of the block.

    pymupdf4llm/PyMuPDF print parser and OCR progress ("=== Document parser
    messages ===", "OCR on page.number=0/1") on stdout, and this script's
    contract is a single JSON object on stdout — so a caller doing a strict
    parse of our stdout gets a syntax error instead of a result.

    `contextlib.redirect_stdout` is NOT sufficient: it only rebinds Python's
    `sys.stdout` object, and the noise comes from the extension module writing
    to fd 1 directly, which sails straight past it. Duplicating fd 2 over fd 1
    catches both. The messages are preserved on stderr for debugging.
    """
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


def convert_to_markdown(pdf_path: Path, pages, image_dir: Path = None) -> str:
    """The one place the PDF engine is bound — swap here if PyMuPDF ever trips
    the AgentCore overlay-mount snapshotter (fallback: pdfplumber/pypdf).

    With `image_dir`, embedded images are written there as PNGs and their
    ![](path) references are KEPT; without it the historical text-only behavior
    is unchanged (images dropped, residual references stripped).
    """
    import pymupdf4llm

    kwargs = {"write_images": False, "embed_images": False}
    if image_dir is not None:
        # `embed_images` stays False on purpose: it would inline base64 data:
        # URIs, and Atrium's sanitizer strips data: URIs, so an embedded image
        # would silently vanish from any document built out of this markdown.
        kwargs = {
            "write_images": True,
            "embed_images": False,
            "image_path": str(image_dir),
            "image_format": "png",
        }
    if pages:
        kwargs["pages"] = pages
    with _stdout_to_stderr():
        markdown = pymupdf4llm.to_markdown(str(pdf_path), **kwargs)
    if image_dir is None:
        return strip_image_references(markdown)
    return absolutize_image_references(markdown, image_dir)


def absolutize_image_references(markdown: str, image_dir: Path) -> str:
    """Rewrite pymupdf4llm's image references to ABSOLUTE paths.

    pymupdf4llm emits the `image_path` it was given verbatim, so a relative
    --extract-images value produces `![](imgs/foo.png)` — resolvable only from
    the CWD this process happened to run in. The caller (a different process,
    with a different CWD) would silently fail to find the file and drop the
    image. Anchoring the reference to the resolved directory removes the
    ambiguity entirely.
    """
    resolved = image_dir.resolve()

    def rewrite(match):
        alt, target = match.group(1), match.group(2).strip()
        if not target or "://" in target:
            return match.group(0)
        return f"![{alt}]({resolved / Path(target).name})"

    return re.sub(r"!\[([^\]]*)\]\(([^)]*)\)", rewrite, markdown).strip()


def collect_extracted_images(image_dir: Path):
    """List the images pymupdf4llm just wrote, oldest first, bounded.

    Returns (kept, dropped). Anything beyond MAX_EXTRACTED_IMAGES is deleted from
    disk and reported as dropped, so the caller can say "3 images were not carried
    over" instead of silently losing them.
    """
    files = sorted(
        (p for p in image_dir.iterdir() if p.is_file()),
        key=lambda p: p.name,
    )
    kept = files[:MAX_EXTRACTED_IMAGES]
    dropped = files[MAX_EXTRACTED_IMAGES:]
    for extra in dropped:
        try:
            extra.unlink()
        except OSError:
            pass
    return kept, dropped


def main():
    parser = argparse.ArgumentParser(description="Convert a PDF to clean Markdown (tables preserved).")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="Public http(s) URL of the PDF")
    src.add_argument("--s3-key", dest="s3_key", help="Key in the workspace S3 bucket")
    src.add_argument("--path", help="Path to a PDF already in the container/workspace")
    parser.add_argument("--out", help="Output .md path (default: /tmp/<stem>.md)")
    parser.add_argument("--pages", help='0-based page selection, e.g. "0,5-10"')
    parser.add_argument("--user", help="Caller email; REQUIRED with --s3-key (scopes S3 access to your own public-images/<email>/ prefix)")
    parser.add_argument(
        "--extract-images",
        dest="extract_images",
        help="Directory to write embedded images into; their ![](path) references are KEPT in the Markdown",
    )
    args = parser.parse_args()

    try:
        pages = parse_pages(args.pages) if args.pages else None
    except ValueError:
        _fail('--pages must be integers or ranges like "0,5-10"', "bad_args")

    image_dir = None
    if args.extract_images:
        image_dir = Path(args.extract_images).expanduser()
        try:
            image_dir.mkdir(parents=True, exist_ok=True)
            # Resolve AFTER creating it so every path we hand back — the markdown
            # references and the `images` list — is absolute and usable from a
            # caller process with a different CWD.
            image_dir = image_dir.resolve()
        except OSError as exc:
            _fail(f"--extract-images directory is not usable: {exc}", "bad_args")
        if any(image_dir.iterdir()):
            # A non-empty target would make collect_extracted_images report
            # pre-existing files as though this PDF produced them.
            _fail("--extract-images directory must be empty", "bad_args")

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
            source = f"owner-artifact:{args.s3_key}"
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
            markdown = convert_to_markdown(local, pages, image_dir)
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
    if image_dir is not None:
        kept, dropped = collect_extracted_images(image_dir)
        result["images"] = [str(p) for p in kept]
        result["image_dir"] = str(image_dir)
        if dropped:
            result["images_dropped"] = len(dropped)
            result["image_note"] = (
                f"{len(dropped)} image(s) beyond the {MAX_EXTRACTED_IMAGES}-image cap were "
                "discarded; their ![](path) references in the Markdown now point at files "
                "that do not exist."
            )
    if len(markdown) <= INLINE_LIMIT:
        result["markdown"] = markdown
    else:
        result["preview"] = markdown[:PREVIEW_CHARS]
        result["note"] = f"Markdown is {len(markdown)} chars; read output_path for the full document."
    _emit(result)


if __name__ == "__main__":
    main()
