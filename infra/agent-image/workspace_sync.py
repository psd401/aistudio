"""
Workspace sync — persists OpenClaw's local state to S3 so the agent has
long-term memory across microVM lifecycles.

OpenClaw stores per-user state under /home/node/.openclaw/ (canvases,
preferences, cached artifacts). AgentCore microVMs are ephemeral, so without
syncing this directory the agent forgets everything between idle-timeouts and
deploys.

This module gives the wrapper three operations:
  - pull_workspace(prefix): on first invocation per microVM, restore the user's
    /home/node/.openclaw/ from s3://$WORKSPACE_BUCKET/<prefix>/
  - push_workspace(prefix): on shutdown (or periodically), upload the current
    contents back to S3
  - start_periodic_push(prefix, interval_s): background thread that pushes on
    a fixed cadence so a hard kill doesn't lose more than `interval_s` of
    state

We intentionally use a flat per-user prefix (no per-session subdir) so the
agent's memory is the user's memory, not the conversation's. A space hash is
already part of OpenClaw's session boundaries; long-term recall belongs to
the user.

S3 keys are skipped if they look like ephemeral logs/sockets to avoid pushing
junk that bloats restores.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("workspace_sync")

WORKSPACE_DIR = Path("/home/node/.openclaw")

# Files/dirs we never sync — runtime cruft that should not persist
_SKIP_PATTERNS = {
    "openclaw.json.bak",  # config backup written every startup
    ".sock",
    ".pid",
}


def _should_skip(path: Path) -> bool:
    name = path.name
    if name.startswith("."):
        # OpenClaw legitimately uses dotfiles for state — only skip clear cruft
        return False
    return any(p in name for p in _SKIP_PATTERNS)


def _s3():
    """
    Build an S3 client that uses the AgentCore task role.

    AWS_PROFILE is set to "default" elsewhere in the container to satisfy
    OpenClaw's credential auth gate. boto3 honors that env var by trying
    to load the named profile from ~/.aws/credentials — which does not
    exist in the AgentCore microVM — and raises ProfileNotFound. Pop the
    var only for client construction so boto3 falls through to the
    container's IMDS-backed task role credentials, then restore it so the
    rest of the process is unaffected.
    """
    import boto3
    saved = os.environ.pop("AWS_PROFILE", None)
    try:
        return boto3.client("s3")
    finally:
        if saved is not None:
            os.environ["AWS_PROFILE"] = saved


def _bucket() -> Optional[str]:
    bucket = os.environ.get("WORKSPACE_BUCKET")
    if not bucket or bucket == "unknown":
        logger.warning("WORKSPACE_BUCKET not set; workspace sync disabled")
        return None
    return bucket


def pull_workspace(prefix: str) -> int:
    """Restore /home/node/.openclaw/ contents from s3://bucket/prefix/."""
    bucket = _bucket()
    if not bucket or not prefix:
        return 0

    s3 = _s3()
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    paginator = s3.get_paginator("list_objects_v2")

    count = 0
    s3_prefix = f"{prefix.rstrip('/')}/"
    for page in paginator.paginate(Bucket=bucket, Prefix=s3_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            relative = key[len(s3_prefix):]
            if not relative:
                continue
            dest = WORKSPACE_DIR / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                s3.download_file(bucket, key, str(dest))
                count += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("workspace pull skip %s: %s", key, exc)

    logger.info("workspace pull: prefix=%s files=%d", prefix, count)
    return count


def push_workspace(prefix: str) -> int:
    """Upload current /home/node/.openclaw/ contents to s3://bucket/prefix/."""
    bucket = _bucket()
    if not bucket or not prefix:
        return 0
    if not WORKSPACE_DIR.exists():
        return 0

    s3 = _s3()
    s3_prefix = f"{prefix.rstrip('/')}/"
    count = 0
    for path in WORKSPACE_DIR.rglob("*"):
        if path.is_dir() or _should_skip(path):
            continue
        relative = path.relative_to(WORKSPACE_DIR).as_posix()
        key = f"{s3_prefix}{relative}"
        try:
            s3.upload_file(str(path), bucket, key)
            count += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("workspace push skip %s: %s", path, exc)

    logger.info("workspace push: prefix=%s files=%d", prefix, count)
    return count


_periodic_thread: Optional[threading.Thread] = None
_periodic_stop = threading.Event()


def start_periodic_push(prefix: str, interval_s: int = 120) -> None:
    """Background thread that pushes the workspace every interval_s seconds."""
    global _periodic_thread
    if _periodic_thread is not None:
        return  # already running

    def _run():
        while not _periodic_stop.wait(interval_s):
            try:
                push_workspace(prefix)
            except Exception as exc:  # noqa: BLE001
                logger.warning("periodic push failed: %s", exc)

    _periodic_thread = threading.Thread(
        target=_run, name="workspace-sync", daemon=True
    )
    _periodic_thread.start()
    logger.info("workspace periodic push started: interval=%ds", interval_s)


def stop_periodic_push() -> None:
    _periodic_stop.set()
