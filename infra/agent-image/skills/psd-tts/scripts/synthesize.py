#!/usr/bin/env python3
"""
synthesize.py — psd-tts.synthesize

Convert text to a shareable MP3 with Amazon Polly, upload it to the workspace S3
bucket under the public `public-images/` prefix, and return an unsigned HTTPS
URL (same delivery model as psd-image-gen / psd-html-artifact).

Polly is NOT Bedrock: it authenticates with the AgentCore execution role's
SigV4 credential chain (the same role that does S3/Secrets), NOT the
AWS_BEARER_TOKEN_BEDROCK token. boto3 needs an explicit region because
AgentCore does not inject AWS_REGION into every SDK path — we read AWS_REGION
(set on the runtime) and fall back to us-east-1.

Usage (text from --text, --file, or stdin):
    python3 synthesize.py --user name@psd401.net --text "Hello there."
    python3 synthesize.py --user name@psd401.net --file /tmp/briefing.txt --voice Matthew
    printf '%s' "$LONG_TEXT" | python3 synthesize.py --user name@psd401.net

Defaults: engine=generative, voice=Ruth, format=mp3. Text longer than one
SynthesizeSpeech call (3,000 billable chars) is split at sentence boundaries and
the MP3 chunks are concatenated.
"""

import argparse
import json
import os
import re
import sys
import uuid
from urllib.parse import quote

# SynthesizeSpeech accepts up to 6,000 total / 3,000 billable chars per call.
# Chunk well under the billable cap at sentence boundaries.
CHUNK_CHARS = 2800
# Guard against pathological inputs (still ~70+ sync calls at the cap).
MAX_TEXT_CHARS = 200_000
VALID_ENGINES = {"generative", "neural", "long-form", "standard"}
DEFAULT_ENGINE = "generative"
DEFAULT_VOICE = "Ruth"

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


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


def synthesize(text, voice, engine, region):
    import boto3

    polly = boto3.client("polly", region_name=region)
    audio = bytearray()
    chunks = chunk_text(text)
    for chunk in chunks:
        # No explicit SampleRate: let Polly pick the engine default (24 kHz for
        # generative/neural/long-form, 22.05 kHz for standard). Hardcoding 24000
        # would reject --engine standard, which does not support that rate.
        resp = polly.synthesize_speech(
            Text=chunk,
            OutputFormat="mp3",
            VoiceId=voice,
            Engine=engine,
        )
        stream = resp.get("AudioStream")
        if stream is None:
            _fail("Polly returned no AudioStream", "upstream_error")
        audio.extend(stream.read())
    return bytes(audio), len(chunks)


def upload_mp3(audio, user_email, region):
    bucket = os.environ.get("WORKSPACE_BUCKET")
    if not bucket:
        _fail("WORKSPACE_BUCKET env var not set — cannot upload audio", "misconfigured")
    import boto3

    key = f"public-images/{user_email}/{uuid.uuid4()}.mp3"
    s3 = boto3.client("s3", region_name=region)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=audio,
        ContentType="audio/mpeg",
        Metadata={"generated_by": "psd-tts"},
    )
    encoded_key = "/".join(quote(seg) for seg in key.split("/"))
    url = f"https://{bucket}.s3.{region}.amazonaws.com/{encoded_key}"
    return url, key


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


def main():
    parser = argparse.ArgumentParser(description="Text to speech via Amazon Polly, delivered as a shareable MP3 URL.")
    parser.add_argument("--user", required=True, help="Caller email (from the [caller: ...] header)")
    parser.add_argument("--text", help="Text to synthesize")
    parser.add_argument("--file", help="Path to a text file to synthesize")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"Polly voice id (default: {DEFAULT_VOICE})")
    parser.add_argument("--engine", default=DEFAULT_ENGINE, choices=sorted(VALID_ENGINES),
                        help=f"Polly engine (default: {DEFAULT_ENGINE})")
    args = parser.parse_args()

    if not valid_email(args.user):
        _fail("--user is required and must be a valid email", "bad_args")

    text = resolve_text(args)
    if not text or not text.strip():
        _fail("no text provided (use --text, --file, or stdin)", "bad_args")
    if len(text) > MAX_TEXT_CHARS:
        _fail(f"text is {len(text)} chars; maximum is {MAX_TEXT_CHARS}", "too_large")

    region = os.environ.get("AWS_REGION", "us-east-1")

    try:
        audio, chunk_count = synthesize(text, args.voice, args.engine, region)
    except Exception as exc:  # botocore ClientError (bad voice/engine, throttling, etc.)
        _fail(f"Polly synthesis failed: {exc}", "upstream_error")

    if not audio:
        _fail("no audio was produced", "upstream_error")

    try:
        url, key = upload_mp3(audio, args.user, region)
    except Exception as exc:  # botocore ClientError, network failure, etc.
        _fail(f"failed to upload audio to S3: {exc}", "upstream_error")
    _emit({
        "status": "ok",
        "url": url,
        "s3Key": key,
        "voice": args.voice,
        "engine": args.engine,
        "characters": len(text),
        "chunks": chunk_count,
        "bytes": len(audio),
        "sharing": "public-by-link",
    })


if __name__ == "__main__":
    main()
