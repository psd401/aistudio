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

# Paths (relative to WORKSPACE_DIR) we never sync in either direction.
#
# These are gateway/agent config owned by the container image — pushing them
# back to S3 then pulling them next boot has caused a real outage: the S3
# copy overwrote the freshly-hydrated apiKey, causing every Mantle call to
# 401 with "Invalid bearer token". Config belongs to the deploy, not the
# workspace. Only user-generated content (notes, sessions, embeddings,
# canvases) should round-trip through S3.
#
# The SOUL.md entry was added after the same bug manifested for the system
# prompt (2026-04-22): an old SOUL.md in each user's S3 workspace was being
# pulled on cold-start, silently overwriting the image's fresh SOUL.md and
# reverting the agent to an older ruleset that lacked the "think silently"
# and "no empty promises" directives. The symptom was that new SOUL rules
# never seemed to "take" — because they were being overlaid to death on
# every pull. Same class of bug as openclaw.json — skip it in both
# directions. User-specific memory files (IDENTITY/USER/MEMORY) are
# intentionally NOT on this list — those are agent-written, user-owned,
# and must round-trip.
#
# Match is: "skip if the relative path equals or starts with any entry".
_SKIP_RELATIVE_PREFIXES = (
    "openclaw.json",                  # gateway config
    "openclaw.json.bak",               # gateway config backup
    "agents/main/agent/models.json",   # per-agent provider/model config
    "logs/",                           # gateway telemetry, not memory
    "update-check.json",               # gateway version probe state
    ".openclaw/",                      # nested OpenClaw internal state
    "SOUL.md",                         # system prompt — image-owned
)

# Filename suffixes that are always runtime cruft (socket files, pid files).
_SKIP_SUFFIXES = (".sock", ".pid")


def _should_skip_relative(relative: str) -> bool:
    """True if this workspace-relative path is gateway-owned, not user memory."""
    rel = relative.lstrip("/")
    for prefix in _SKIP_RELATIVE_PREFIXES:
        if rel == prefix or rel.startswith(prefix):
            return True
    return any(rel.endswith(suf) for suf in _SKIP_SUFFIXES)


def _should_skip(path: Path) -> bool:
    """Path-based wrapper for push-side filtering."""
    try:
        relative = path.relative_to(WORKSPACE_DIR).as_posix()
    except ValueError:
        return False
    return _should_skip_relative(relative)


def _s3():
    """
    Build an S3 client that uses the AgentCore task role.

    AgentCore doesn't set AWS_REGION; boto3 requires one for most services.
    Default to us-east-1 (where this stack lives). The AWS_PROFILE pop
    below is a legacy concern — we no longer set AWS_PROFILE — but kept as
    a defensive measure in case anything downstream reintroduces it.
    """
    import boto3
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    saved = os.environ.pop("AWS_PROFILE", None)
    try:
        return boto3.client("s3", region_name=region)
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
    skipped = 0
    s3_prefix = f"{prefix.rstrip('/')}/"
    for page in paginator.paginate(Bucket=bucket, Prefix=s3_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            relative = key[len(s3_prefix):]
            if not relative:
                continue
            if _should_skip_relative(relative):
                # Gateway-owned config or telemetry. Never let S3 state
                # override the image-provided version.
                skipped += 1
                continue
            dest = WORKSPACE_DIR / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                s3.download_file(bucket, key, str(dest))
                count += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("workspace pull skip %s: %s", key, exc)

    logger.info(
        "workspace pull: prefix=%s files=%d skipped_config=%d",
        prefix, count, skipped,
    )
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
