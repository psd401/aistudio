"""Owner-bound artifact storage client for model-facing Python skills."""

from __future__ import annotations

import json
import base64
import hashlib
import os
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Tuple


def _broker(payload: dict, timeout: int = 20) -> dict:
    request = urllib.request.Request(
        "http://127.0.0.1:18791/agent-broker/api/agent/workspace-storage",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        result = json.loads(response.read())
    if not isinstance(result, dict):
        raise RuntimeError("artifact broker returned invalid JSON")
    return result


# A Drive delivery does two Google round trips (resumable upload + share)
# behind the broker call. Mirrors DELIVER_TIMEOUT_MS in
# skills/_shared/drive-deliverer.js.
DRIVE_DELIVER_TIMEOUT_SECONDS = 240

# Mirrors skills/_shared/delivery-choice.js (#2034): every agent output is
# private to the requester by default; a public link needs `--to public` AND
# this flag, which records that the user was asked and said yes.
PUBLIC_CONFIRMED_FLAG = "--public-confirmed"
PUBLIC_NEEDS_CONFIRMATION_MESSAGE = (
    "Public links are opt-in and need the user's explicit yes. Nothing was "
    "uploaded. Deliver privately instead (omit --to public: the file goes to "
    "your Drive, shared with the requester only). Use a public link ONLY if the "
    "user asked for one: ask them first, in plain words, \"This will be a public "
    "link — anyone who gets it can open it without signing in, for 30 days. "
    "OK?\" If, and only if, they say yes, run the same command again with "
    "--to public " + PUBLIC_CONFIRMED_FLAG + "."
)


def public_needs_confirmation(to: str, public_confirmed: bool) -> bool:
    """True when a public link was asked for without the confirmation flag."""
    return to == "public" and not public_confirmed


def _stage_upload(operation: str, path: str, body: bytes, content_type: str) -> str:
    """Stage bytes under a fresh broker reservation and return its id.

    The Python twin of skills/_shared/staged-upload.js: ask the broker for a
    signed PUT, prove the signed contract came back intact, send the bytes
    straight to S3.
    """
    checksum_sha256 = base64.b64encode(
        hashlib.sha256(body).digest()
    ).decode("ascii")
    prepared = _broker(
        {
            "operation": operation,
            "path": path,
            "contentType": content_type,
            "contentLength": len(body),
            "idempotencyKey": str(uuid.uuid4()),
            "checksumSha256": checksum_sha256,
        }
    )
    upload_url = prepared.get("uploadUrl")
    reservation_id = prepared.get("reservationId")
    required_headers = prepared.get("requiredHeaders")
    if (
        not isinstance(upload_url, str)
        or not isinstance(reservation_id, str)
        or not isinstance(required_headers, dict)
        or set(required_headers) != {
            "Content-Length",
            "Content-Type",
            "x-amz-checksum-sha256",
        }
        or required_headers.get("Content-Length") != str(len(body))
        or required_headers.get("Content-Type") != content_type
        or required_headers.get("x-amz-checksum-sha256") != checksum_sha256
    ):
        raise RuntimeError("artifact broker returned an incomplete upload")
    request = urllib.request.Request(
        upload_url,
        data=body,
        method="PUT",
        headers=required_headers,
    )
    with urllib.request.urlopen(request, timeout=120):
        pass
    return reservation_id


def publish_artifact(
    body: bytes,
    extension: str,
    content_type: str,
) -> Tuple[str, str]:
    """Publish bytes as an unsigned, PUBLIC-BY-LINK object (opt-in only).

    Callers must only reach this after the user confirmed a public link
    (`--to public --public-confirmed`, #2034). The default for every agent
    output is `deliver_to_drive`.
    """
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", extension):
        raise ValueError("invalid artifact extension")
    reservation_id = _stage_upload(
        "publish", f"{uuid.uuid4()}{extension}", body, content_type
    )
    completed = _broker({
        "operation": "complete-upload",
        "reservationId": reservation_id,
    })
    public_url = completed.get("publicUrl")
    key = completed.get("key")
    if not isinstance(public_url, str) or not isinstance(key, str):
        raise RuntimeError("artifact broker did not verify the upload")
    return public_url, key


def deliver_to_drive(body: bytes, file_name: str, content_type: str) -> dict:
    """Deliver bytes PRIVATELY: a file in the agent account's Drive, shared
    with the caller alone as a writer (#1885, #2034).

    The Python twin of skills/_shared/drive-deliverer.js. Nothing becomes
    public-by-link and Drive files do not expire. Returns the broker's
    verified result: `fileId`, `webViewLink`, `sharedWith`, `fileName`.
    """
    if not isinstance(file_name, str) or "/" in file_name or not file_name.strip():
        raise ValueError("invalid Drive file name")
    reservation_id = _stage_upload("drive-upload", file_name, body, content_type)
    delivered = _broker(
        {"operation": "deliver-to-drive", "reservationId": reservation_id},
        timeout=DRIVE_DELIVER_TIMEOUT_SECONDS,
    )
    if (
        not isinstance(delivered.get("fileId"), str)
        or not isinstance(delivered.get("webViewLink"), str)
        or not isinstance(delivered.get("sharedWith"), str)
    ):
        raise RuntimeError("Drive delivery verification failed")
    return delivered


def download_public_artifact(
    key: str,
    destination: Path,
    max_bytes: int,
) -> None:
    if not isinstance(max_bytes, int) or max_bytes < 1:
        raise ValueError("max_bytes must be a positive integer")
    prepared = _broker({"operation": "download-public", "path": key})
    download_url = prepared.get("downloadUrl")
    content_length = prepared.get("contentLength")
    required_headers = prepared.get("requiredHeaders")
    if (
        not isinstance(download_url, str)
        or not isinstance(content_length, int)
        or content_length < 1
        or content_length > max_bytes
        or not isinstance(required_headers, dict)
        or not isinstance(required_headers.get("Range"), str)
    ):
        raise RuntimeError("artifact broker returned an invalid bounded download")
    request = urllib.request.Request(
        download_url,
        headers={"Range": required_headers["Range"]},
    )
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            response_length = response.headers.get("Content-Length")
            if response_length is not None:
                try:
                    parsed_length = int(response_length)
                except ValueError as exc:
                    raise RuntimeError(
                        "artifact response length is invalid"
                    ) from exc
                if parsed_length != content_length:
                    raise RuntimeError("artifact response length changed")
            with destination.open("wb") as output:
                while True:
                    chunk = response.read(
                        min(1024 * 1024, max_bytes - total + 1)
                    )
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes or total > content_length:
                        raise RuntimeError("artifact exceeds the download limit")
                    output.write(chunk)
        if total != content_length:
            raise RuntimeError("artifact download was incomplete")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
