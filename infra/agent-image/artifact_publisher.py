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


def _broker(payload: dict) -> dict:
    request = urllib.request.Request(
        "http://127.0.0.1:18791/agent-broker/api/agent/workspace-storage",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.loads(response.read())
    if not isinstance(result, dict):
        raise RuntimeError("artifact broker returned invalid JSON")
    return result


def publish_artifact(
    body: bytes,
    extension: str,
    content_type: str,
) -> Tuple[str, str]:
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", extension):
        raise ValueError("invalid artifact extension")
    checksum_sha256 = base64.b64encode(
        hashlib.sha256(body).digest()
    ).decode("ascii")
    prepared = _broker(
        {
            "operation": "publish",
            "path": f"{uuid.uuid4()}{extension}",
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
    completed = _broker({
        "operation": "complete-upload",
        "reservationId": reservation_id,
    })
    public_url = completed.get("publicUrl")
    key = completed.get("key")
    if not isinstance(public_url, str) or not isinstance(key, str):
        raise RuntimeError("artifact broker did not verify the upload")
    return public_url, key


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
