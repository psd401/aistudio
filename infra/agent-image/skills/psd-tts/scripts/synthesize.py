#!/usr/bin/env python3
"""
synthesize.py — psd-tts.synthesize

Convert text to an MP3 with Amazon Polly and deliver it PRIVATELY: the file is
created in the agent account's Drive and shared with the requester alone
(#2034). Nothing is public by default, whatever the narration says.

Three destinations (`--to`):
    drive   (default) private Drive file, shared with the caller only.
    file    write the MP3 to a local path (`--out`) and upload nothing — for a
            soundtrack another skill consumes (psd-hyperframes --audio-file).
    public  unsigned public-by-link URL, deleted after 30 days. Opt-in only:
            refused unless `--public-confirmed` is also passed, which records
            that the user was asked and said yes. The narration personal-data
            check (#1886) still runs on this path as a backstop.

The root-owned loopback relay calls Polly with the AgentCore execution role's
SigV4 credential chain. OpenClaw intentionally strips credential variables from
model-launched exec subprocesses, so this script never receives or returns
reusable AWS credentials. The resulting MP3 is uploaded through the owner-bound
workspace broker; the model role has no S3 or Secrets Manager access.

Usage (text from --text, --file, or stdin):
    python3 synthesize.py --user name@psd401.net --text "Hello there."
    python3 synthesize.py --user name@psd401.net --name "Board recap" --text "..."
    python3 synthesize.py --user name@psd401.net --to file \
        --out /home/node/.openclaw/work/voiceover.mp3 --text "..."
    python3 synthesize.py --user name@psd401.net --file /home/node/.openclaw/work/briefing.txt \
        --voice Matthew
    printf '%s' "$LONG_TEXT" | python3 synthesize.py --user name@psd401.net

Defaults: engine=generative, voice=Ruth, format=mp3. Text longer than one
SynthesizeSpeech call (3,000 billable chars) is split at sentence boundaries and
the MP3 chunks are concatenated.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

# SynthesizeSpeech accepts up to 6,000 total / 3,000 billable chars per call.
# Chunk well under the billable cap at sentence boundaries.
CHUNK_CHARS = 2800
# Guard against pathological inputs (still ~70+ sync calls at the cap).
MAX_TEXT_CHARS = 200_000
VALID_ENGINES = {"generative", "neural", "long-form", "standard"}
DEFAULT_ENGINE = "generative"
DEFAULT_VOICE = "Ruth"
POLLY_RELAY_URL = "http://127.0.0.1:18791/aws-skill/polly/synthesize"
MAX_RELAY_AUDIO_BYTES = 16 * 1024 * 1024

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
# The broker's SAFE_PUBLIC_ARTIFACT_NAME rule for a Drive delivery file name.
_UNSAFE_NAME_CHARS_RE = re.compile(r"[^A-Za-z0-9._@+= -]+")
MAX_NAME_CHARS = 120
DESTINATIONS = ("drive", "file", "public")


def _fail(message, code="error"):
    print(json.dumps({"status": "error", "error": code, "message": message}))
    sys.exit(1)


def _emit(obj):
    print(json.dumps(obj, indent=2))


def valid_email(email):
    # Reject `/` because the email is interpolated into the S3 key path.
    return bool(email) and bool(_EMAIL_RE.match(email)) and "/" not in email


def chunk_text(text, max_chars=CHUNK_CHARS):
    """Split text into <=max_chars chunks at sentence boundaries."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks, current = [], ""
    for sentence in sentences:
        # A single sentence longer than the cap is hard-split on whitespace.
        while len(sentence) > max_chars:
            head, sentence = sentence[:max_chars], sentence[max_chars:]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head)
        if not current:
            current = sentence
        elif len(current) + 1 + len(sentence) <= max_chars:
            current += " " + sentence
        else:
            chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return [c for c in chunks if c.strip()]


def _read_bounded_response(response, max_bytes):
    body = bytearray()
    while True:
        chunk = response.read(min(64 * 1024, max_bytes - len(body) + 1))
        if not chunk:
            break
        body.extend(chunk)
        if len(body) > max_bytes:
            raise RuntimeError("Polly relay response exceeded the configured limit")
    return bytes(body)


def _synthesize_chunk(text, voice, engine):
    request = urllib.request.Request(
        POLLY_RELAY_URL,
        data=json.dumps({
            "text": text,
            "voice": voice,
            "engine": engine,
        }).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if response.headers.get_content_type() != "audio/mpeg":
                raise RuntimeError("Polly relay returned an invalid content type")
            return _read_bounded_response(response, MAX_RELAY_AUDIO_BYTES)
    except urllib.error.HTTPError as exc:
        exc.read(1024)
        raise RuntimeError(f"Polly relay returned HTTP {exc.code}") from exc


def synthesize(text, voice, engine, synthesize_chunk=None):
    relay = synthesize_chunk or _synthesize_chunk
    audio = bytearray()
    chunks = chunk_text(text)
    for chunk in chunks:
        audio.extend(relay(chunk, voice, engine))
    return bytes(audio), len(chunks)


def _add_image_modules_to_path():
    """
    Put the image's /app modules (and, under test, the repository's
    infra/agent-image) on sys.path.

    Done lazily rather than at import time because the unit suite loads this
    file by path, outside any package.
    """
    candidates = [
        os.path.abspath(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
        ),
        "/app",
    ]
    for candidate in candidates:
        if candidate not in sys.path:
            sys.path.insert(0, candidate)


def upload_mp3(audio, user_email, region):
    """Publish the MP3 PUBLIC-BY-LINK. Opt-in only (`--to public --public-confirmed`)."""
    _add_image_modules_to_path()
    from artifact_publisher import publish_artifact
    _ = (user_email, region)
    return publish_artifact(audio, ".mp3", "audio/mpeg")


def deliver_mp3_to_drive(audio, file_name):
    """The default: a private Drive file shared with the caller alone (#2034)."""
    _add_image_modules_to_path()
    from artifact_publisher import deliver_to_drive
    return deliver_to_drive(audio, file_name, "audio/mpeg")


def drive_file_name(name, now=None):
    """
    The Drive file name: `--name` made safe for the broker, or a dated default.

    The broker accepts letters, digits, space and `._@+=-` only, so anything
    else is collapsed to a space rather than refused — a title like
    "Board recap: Nov 11" should still deliver.
    """
    base = _UNSAFE_NAME_CHARS_RE.sub(" ", name or "").strip(" .")
    base = re.sub(r"\s+", " ", base)[:MAX_NAME_CHARS].strip(" .")
    if base.lower().endswith(".mp3"):
        base = base[:-4].strip(" .")
    if not base:
        stamp = (now or dt.datetime.now()).strftime("%Y-%m-%d %H%M")
        base = f"Narration {stamp}"
    return f"{base}.mp3"


def write_mp3_file(audio, out_path):
    """`--to file`: write the MP3 locally and upload nothing."""
    path = os.path.abspath(os.path.expanduser(out_path))
    if not path.lower().endswith(".mp3"):
        raise ValueError("--out must end in .mp3")
    parent = os.path.dirname(path)
    if not os.path.isdir(parent):
        raise ValueError(f"--out directory does not exist: {parent}")
    with open(path, "wb") as fh:
        fh.write(audio)
    return path


def narration_personal_data(text):
    """
    The kinds of personal data in the narration, or [] — the #1886 gate.

    ONLY ON THE PUBLIC PATH (#2034). Private delivery (the default) is not
    content-checked: a private recording may say anything its requester could
    read, and visibility is never decided from a content scan. This check is a
    backstop for the one case where a user deliberately widens a recording to
    a public link.

    WHY THIS IS STRICTER THAN THE PUBLIC-FILE GATE. A public MP3 is
    unsigned (deleted after 30 days by the
    `expire-public-artifacts` lifecycle rule), and once synthesised the bytes
    are opaque audio that no later text check can read — the broker's
    public-link scan does not read audio. Seven morning-brief podcasts were
    found speaking staff contact details on open URLs. There is also nothing
    to lose by refusing: the narration can say "call the front office"
    instead.
    So this uses the `narration` policy, which refuses on the FIRST match,
    while a public *file* is allowed one contact detail (a school phone number
    in a flyer footer).

    FAILS CLOSED. If the canonical pattern file cannot be loaded the skill
    refuses rather than synthesising unchecked — the file is staged into the
    image by build-and-push.sh and its presence is a build-time test, so a
    load failure means the image is broken, not that this text is safe.
    """
    _add_image_modules_to_path()
    from personal_data import personal_data_kinds

    return personal_data_kinds(text)


def _record_narration_refusal(user_email, kinds):
    """
    Count the refusal in `agent_failures` so the gate's false-positive rate is
    measurable (#1886 asks for every refusal to be logged). Best-effort: the
    refusal is reported to the caller whether or not the row lands.
    """
    try:
        _add_image_modules_to_path()
        from agent_failures import record_failure

        record_failure(
            "harness",
            "warn",
            # The kinds, never the matched values.
            "psd-tts refused: narration contains " + ", ".join(kinds),
            user_id=user_email,
            error_class="NarrationPersonalDataRefused",
            context={"skill": "psd-tts", "kinds": list(kinds)},
        )
    except Exception:  # noqa: BLE001 - never let the reporter mask the refusal
        pass


def resolve_text(args):
    if args.text:
        return args.text
    if args.file:
        path = os.path.expanduser(args.file)
        if not os.path.isfile(path):
            _fail(f"--file not found: {path}", "bad_args")
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Text to speech via Amazon Polly, delivered privately to your Drive by default."
    )
    parser.add_argument("--user", required=True, help="Caller email (from the [caller: ...] header)")
    parser.add_argument("--text", help="Text to synthesize")
    parser.add_argument("--file", help="Path to a text file to synthesize")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"Polly voice id (default: {DEFAULT_VOICE})")
    parser.add_argument("--engine", default=DEFAULT_ENGINE, choices=sorted(VALID_ENGINES),
                        help=f"Polly engine (default: {DEFAULT_ENGINE})")
    parser.add_argument("--to", default="drive", choices=DESTINATIONS,
                        help="drive (default, private to you) | file (local --out path) | public (opt-in)")
    parser.add_argument("--public-confirmed", action="store_true",
                        help="Required with --to public: the user was asked and said yes")
    parser.add_argument("--name", help="Drive file name (default: 'Narration <date time>')")
    parser.add_argument("--out", help="Local .mp3 path, required with --to file")
    return parser.parse_args(argv)


def main():
    args = _parse_args()

    if not valid_email(args.user):
        _fail("--user is required and must be a valid email", "bad_args")

    # Before any text is read or any Polly call is paid for: a public link is
    # never the result of a default or a single flag (#2034).
    _add_image_modules_to_path()
    from artifact_publisher import (
        PUBLIC_NEEDS_CONFIRMATION_MESSAGE,
        public_needs_confirmation,
    )
    if public_needs_confirmation(args.to, args.public_confirmed):
        _fail(PUBLIC_NEEDS_CONFIRMATION_MESSAGE, "public_needs_confirmation")
    if args.to == "file" and not args.out:
        _fail("--to file needs --out <path.mp3>", "bad_args")
    if args.to != "file" and args.out:
        _fail("--out is only used with --to file", "bad_args")

    text = resolve_text(args)
    if not text or not text.strip():
        _fail("no text provided (use --text, --file, or stdin)", "bad_args")
    if len(text) > MAX_TEXT_CHARS:
        _fail(f"text is {len(text)} chars; maximum is {MAX_TEXT_CHARS}", "too_large")

    # The #1886 gate, PUBLIC PATH ONLY, BEFORE synthesis: nothing is sent to
    # Polly and nothing is uploaded. A public recording is unreadable to any
    # later check. Private delivery is not content-gated (#2034).
    if args.to == "public":
        try:
            refused_kinds = narration_personal_data(text)
        except Exception as exc:  # noqa: BLE001 - fails closed, see the docstring
            _fail(f"personal-data check unavailable: {exc}", "gate_unavailable")
        if refused_kinds:
            _record_narration_refusal(args.user, refused_kinds)
            _fail(
                "the narration contains personal data ("
                + ", ".join(refused_kinds)
                + ") and was asked for as a PUBLIC link. Nothing was recorded. "
                "Deliver it privately instead: run the same command without "
                "--to public (the default puts it in your Drive, shared with "
                "the requester only). Only if it must be public, rewrite the "
                "narration without the contact details and student numbers.",
                "personal_data_detected",
            )

    region = os.environ.get("AWS_REGION", "us-east-1")

    try:
        audio, chunk_count = synthesize(text, args.voice, args.engine)
    except Exception as exc:
        _fail(f"Polly synthesis failed: {exc}", "upstream_error")

    if not audio:
        _fail("no audio was produced", "upstream_error")

    common = {
        "status": "ok",
        "voice": args.voice,
        "engine": args.engine,
        "characters": len(text),
        "chunks": chunk_count,
        "bytes": len(audio),
    }

    if args.to == "file":
        try:
            path = write_mp3_file(audio, args.out)
        except (OSError, ValueError) as exc:
            _fail(f"could not write --out: {exc}", "bad_args")
        _emit({**common, "path": path, "sharing": "local-file"})
        return

    if args.to == "public":
        try:
            url, key = upload_mp3(audio, args.user, region)
        except Exception as exc:  # botocore ClientError, network failure, etc.
            _fail(f"failed to upload audio to S3: {exc}", "upstream_error")
        _emit({
            **common,
            "url": url,
            "s3Key": key,
            "sharing": "public-by-link",
            "expires": "30 days after publication",
        })
        return

    try:
        delivered = deliver_mp3_to_drive(audio, drive_file_name(args.name))
    except Exception as exc:  # noqa: BLE001 - broker / Drive failure
        _fail(f"failed to deliver audio to Drive: {exc}", "upstream_error")
    _emit({
        **common,
        "url": delivered["webViewLink"],
        "driveFileId": delivered["fileId"],
        "fileName": delivered.get("fileName"),
        "sharing": "private-shared-with-caller",
        "sharedWith": delivered["sharedWith"],
        "expires": "never",
    })


if __name__ == "__main__":
    main()
