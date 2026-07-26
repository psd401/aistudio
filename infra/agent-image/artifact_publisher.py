"""Owner-bound artifact storage client for model-facing Python skills."""

from __future__ import annotations

import json
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
    prepared = _broker(
        {
            "operation": "publish",
            "path": f"{uuid.uuid4()}{extension}",
            "contentType": content_type,
        }
    )
    upload_url = prepared.get("uploadUrl")
    public_url = prepared.get("publicUrl")
    key = prepared.get("key")
    if not all(isinstance(value, str) for value in (upload_url, public_url, key)):
        raise RuntimeError("artifact broker returned an incomplete upload")
    request = urllib.request.Request(
        upload_url,
        data=body,
        method="PUT",
        headers={"Content-Type": content_type},
    )
    with urllib.request.urlopen(request, timeout=120):
        pass
    return public_url, key


def download_public_artifact(key: str, destination: Path) -> None:
    prepared = _broker({"operation": "download-public", "path": key})
    download_url = prepared.get("downloadUrl")
    if not isinstance(download_url, str):
        raise RuntimeError("artifact broker returned no download URL")
    with urllib.request.urlopen(download_url, timeout=120) as response:
        with destination.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
