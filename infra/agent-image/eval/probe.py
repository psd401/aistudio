#!/usr/bin/env python3
"""Shared invocation helpers for the build gate and the evaluation runner.

This module deliberately uses only the Python standard library. The build gate
calls it before an image is pushed, so adding a package-manager dependency here
would turn a small parsing helper into another way to waive the gate.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
from collections.abc import Iterable

DEFAULT_OWNER_EMAIL = "canary@build-gate.invalid"


class ProbeProtocolError(ValueError):
    """The invocation stream did not contain a usable terminal event."""


def decode_owner_email(
    invocation_context: str,
    fallback: str = DEFAULT_OWNER_EMAIL,
) -> str:
    """Read ownerEmail from a signed context without attempting verification."""
    try:
        segment = invocation_context.strip().split(".")[1]
        padding = "=" * (-len(segment) % 4)
        claims = json.loads(base64.urlsafe_b64decode(segment + padding))
        owner_email = claims.get("ownerEmail")
        return owner_email if isinstance(owner_email, str) and owner_email else fallback
    except (
        binascii.Error,
        IndexError,
        KeyError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ):
        return fallback


def build_invocation_payload(
    prompt: str,
    owner_email: str,
    invocation_context: str,
    request_proof_key: str,
) -> str:
    """Serialize the wrapper payload shared by canary and eval invocations."""
    return json.dumps(
        {
            "prompt": prompt,
            "user_email": owner_email,
            "invocation_context": invocation_context,
            "invocation_request_proof_key": request_proof_key,
        },
        separators=(",", ":"),
    )


def parse_sse_events(lines: Iterable[str]) -> Iterable[dict[str, object]]:
    """Yield JSON objects from SSE ``data:`` lines, ignoring other frames."""
    for raw_line in lines:
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:") :].strip()
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def extract_last_result_event(stream: str) -> dict[str, object]:
    """Return the last SSE event carrying ``result``.

    The wrapper echoes the prompt under ``metadata.messages``. Selecting the
    terminal event instead of grepping the raw stream prevents the build gate
    and eval runner from passing on that echoed prompt.
    """
    final_event: dict[str, object] | None = None
    for event in parse_sse_events(stream.splitlines()):
        if "result" in event:
            final_event = event
    if final_event is None:
        raise ProbeProtocolError("invocation stream contained no result event")
    return final_event


def extract_last_result_text(stream: str) -> str:
    """Return the terminal result coerced the same way as the legacy gate."""
    result = extract_last_result_event(stream).get("result")
    return str(result or "")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    owner = subparsers.add_parser("owner-email")
    owner.add_argument("invocation_context")

    payload = subparsers.add_parser("make-payload")
    payload.add_argument("prompt")
    payload.add_argument("owner_email")
    payload.add_argument("invocation_context")
    payload.add_argument("request_proof_key")

    subparsers.add_parser("last-result")
    subparsers.add_parser("last-event")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "owner-email":
        print(decode_owner_email(args.invocation_context))
        return 0
    if args.command == "make-payload":
        print(
            build_invocation_payload(
                args.prompt,
                args.owner_email,
                args.invocation_context,
                args.request_proof_key,
            )
        )
        return 0

    stream = sys.stdin.read()
    try:
        event = extract_last_result_event(stream)
    except ProbeProtocolError as error:
        # The legacy build gate treated a missing result as an empty answer,
        # then wrote its normal canary_ok=false artifact. Preserve that control
        # flow for the shared last-result command; last-event remains strict for
        # the eval runner and diagnostics.
        if args.command == "last-result":
            print("")
            return 0
        print(str(error), file=sys.stderr)
        return 2
    if args.command == "last-result":
        print(str(event.get("result") or ""))
    else:
        print(json.dumps(event, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
