"""
Workspace sync — persists OpenClaw's local state through the owner-bound web
storage broker so the agent has
long-term memory across microVM lifecycles.

OpenClaw stores per-user state under /home/node/.openclaw/ (canvases,
preferences, cached artifacts). AgentCore microVMs are ephemeral, so without
syncing this directory the agent forgets everything between idle-timeouts and
deploys.

This module gives the wrapper four operations:
  - pull_workspace(prefix): on first invocation per microVM, restore the user's
    /home/node/.openclaw/ from the signed invocation context's workspace prefix
  - mark_openclaw_migration_complete(): persist the one-time JSONL → SQLite
    migration boundary without deleting the versioned legacy source objects
  - prepare_sqlite_snapshot(): checkpoint and validate OpenClaw's databases
    after the gateway has stopped
  - push_workspace(prefix): upload that stable state at each turn boundary and
    on graceful shutdown

We intentionally use a flat per-user prefix (no per-session subdir) so the
agent's memory is the user's memory, not the conversation's. A space hash is
already part of OpenClaw's session boundaries; long-term recall belongs to
the user.

S3 keys are skipped if they look like ephemeral logs/sockets to avoid pushing
junk that bloats restores.
"""

from __future__ import annotations

import logging
import http.client
import base64
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger("workspace_sync")

class WorkspaceRestoreIncomplete(RuntimeError):
    """Restore did not faithfully reproduce S3.

    The caller MUST NOT push after this: the local tree is missing files that
    still exist remotely, and pushing would overwrite them with stale state or
    image defaults.
    """


WORKSPACE_DIR = Path("/home/node/.openclaw")
# All of these are runaway-traversal BACKSTOPS, not product limits. #1353 set
# them below real-world workspace sizes and the sync path treated hitting one
# as a fatal error, which on 2026-07-27 destroyed a user's agent memory:
# restore raised -> container kept image defaults -> a later push wrote those
# defaults over the real files in S3.
#
# Sizes now sit far above any plausible workspace, and — more importantly —
# hitting one can no longer fail a restore. See pull_workspace().
MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_SYNC_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
# Raised from 1,000 (#1353) after that cap silently destroyed a user's agent
# memory on 2026-07-27. Real workspaces already exceed it: two of the 38 live
# prefixes hold ~5,000 objects each. The cap is a runaway-traversal backstop,
# not a product limit, so it sits far above any plausible workspace.
#
# CRITICAL: a restore must NEVER fail because of this number. Restoring FEWER
# files than exist is a silent-corruption bug — the agent boots with image
# defaults and a later push then writes those defaults over the real files in
# S3. See pull_workspace().
MAX_SYNC_FILES = 250_000
# Count every directory entry, including directories, symlinks, sockets, and
# other unsafe objects.  A model-controlled tree must not turn the privileged
# final flush into an unbounded traversal even when none of those entries are
# eligible for upload.
# Was 4,000 — below live workspaces (two prefixes hold ~5,000 objects), so the
# PUSH silently truncated and never uploaded the tail of a user's workspace.
MAX_SYNC_ENTRIES = 250_000
MAX_SYNC_DEPTH = 64
SYNC_WORKERS = 4
TRANSFER_CHUNK_BYTES = 64 * 1024
WORKSPACE_UPLOAD_CONTENT_TYPE = "application/octet-stream"
WORKSPACE_FLUSH_TOKEN_PATH = (
    "/run/psd-agent-authority/workspace-flush-token"
)
_uploaded_state: dict[tuple[str, str], tuple[int, int]] = {}

# OpenClaw 2026.7 is SQLite-first. The marker is part of the owner workspace,
# so it survives a microVM shutdown and tells future restores that the legacy
# JSONL/attestation archive has already been imported. The legacy S3 objects
# remain untouched (and the bucket is versioned); they are simply no longer
# downloaded on every cold boot.
OPENCLAW_MIGRATION_MARKER = "state/psd-openclaw-sqlite-migration-v1.json"
_OPENCLAW_MIGRATION_MARKER_BYTES = (
    b'{"version":1,"storage":"openclaw-sqlite","legacyArchivePreserved":true}\n'
)


def _download_workspace_file(
    source_url: str,
    destination: Path,
    workspace_root: Path,
    content_length: int,
    required_headers: dict[str, str],
) -> None:
    """Restore one exact bounded object without root writing into model state."""
    destination.relative_to(workspace_root)
    writer = r"""
import os
import pathlib
import sys
import uuid
root = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2])
resolved = destination.resolve(strict=False)
resolved.relative_to(root)
resolved.parent.mkdir(parents=True, exist_ok=True)
temporary = resolved.with_name(f".{resolved.name}.{uuid.uuid4().hex}.tmp")
try:
    with temporary.open("xb") as output:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    os.replace(temporary, resolved)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
"""
    request = urllib.request.Request(source_url, headers=required_headers)
    written = 0
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix="workspace-download-",
        dir="/tmp",
    )
    temporary_path = Path(temporary_name)
    process: subprocess.Popen[bytes] | None = None
    try:
        with os.fdopen(temporary_fd, "wb") as output:
            with urllib.request.urlopen(request, timeout=60) as response:
                response_length = response.headers.get("Content-Length")
                if response_length is not None and (
                    not response_length.isdigit()
                    or int(response_length) != content_length
                ):
                    raise RuntimeError("workspace download length mismatch")
                while True:
                    chunk = response.read(TRANSFER_CHUNK_BYTES)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > content_length:
                        raise RuntimeError(
                            "workspace download exceeded declared length"
                        )
                    output.write(chunk)
        if written != content_length:
            raise RuntimeError("workspace download ended before declared length")

        process_options: dict[str, object] = {}
        if os.geteuid() == 0:
            process_options = {
                "user": "node",
                "group": "node",
                "extra_groups": [],
                "umask": 0o077,
            }
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                writer,
                str(workspace_root),
                str(destination),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            cwd=str(workspace_root),
            **process_options,
        )
        assert process.stdin is not None
        with temporary_path.open("rb") as source:
            while True:
                chunk = source.read(TRANSFER_CHUNK_BYTES)
                if not chunk:
                    break
                process.stdin.write(chunk)
        process.stdin.close()
        stderr = process.stderr.read(500) if process.stderr else b""
        return_code = process.wait(timeout=60)
        if process.stderr is not None:
            process.stderr.close()
        if return_code != 0:
            raise RuntimeError(
                f"node workspace writer failed ({return_code}): "
                f"{stderr.decode('utf-8', errors='replace')}"
            )
    except Exception:
        if process is not None:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if process.stderr is not None and not process.stderr.closed:
                process.stderr.close()
        raise
    finally:
        temporary_path.unlink(missing_ok=True)

# Paths (relative to WORKSPACE_DIR) we never sync in either direction.
#
# These are gateway/agent config owned by the container image — pushing them
# back to storage then pulling them next boot has caused real outages by
# overwriting image-owned provider configuration. Config belongs to the deploy,
# not the workspace. Only user-generated content (notes, sessions, embeddings,
# canvases) should round-trip through the owner-bound broker.
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
    # Image-bundled skills — every file under these prefixes is shipped by
    # the container deploy and must never be overlaid by S3 state. Same
    # class of bug as SOUL.md (2026-04-26): stale skill files in each
    # user's S3 prefix (debug-*.js, old SKILL.md, old common.js) were
    # pulled on cold-start and overwriting the new image's psd-workspace
    # skill, so Phase 1 user_account scope handling never took effect
    # after the image was rebuilt and redeployed.
    #
    # IMPORTANT: skills/user/ is the agent's own authoring scratchpad —
    # NOT image-owned, must round-trip. Don't blanket-skip skills/.
    # Image-bundled skills now live at /opt/psd-skills/, OUTSIDE this
    # workspace dir, so they CANNOT be overlaid by S3 state — the path
    # separation makes the "agent overwrites a district skill" bug class
    # physically impossible. The skip entries below remain as a defense
    # against S3 pollution: stale files exist in some users' workspace
    # prefixes from the pre-separation era, and an agent that hand-creates
    # `~/.openclaw/skills/psd-foo/` would sync that scratch to S3 forever.
    # Skipping these prefixes prevents both. Keep the list aligned with
    # the directories that exist at /opt/psd-skills/.
    "skills/gws-",
    "skills/psd-brand-guidelines/",
    "skills/psd-credentials/",
    "skills/psd-data/",
    "skills/psd-failure-report/",
    "skills/psd-freshservice/",
    "skills/psd-github/",
    "skills/psd-html-artifact/",
    # psd-html-output was REMOVED from the image (superseded by psd-html-artifact),
    # but its skip entry is intentionally retained: stale objects may linger in
    # some users' pre-separation S3 prefixes, and skipping the pull keeps the
    # deleted skill from being resurrected under ~/.openclaw/skills/ on sync.
    "skills/psd-html-output/",
    "skills/psd-image-gen/",
    # psd-redrover was REMOVED from the image (#1396 — Red Rover data is now
    # served through the warehouse via psd-data, which authenticates as the
    # calling user), but its skip entry is intentionally retained for the same
    # reason as psd-html-output above: stale synced copies in users' S3
    # prefixes must not be resurrected under ~/.openclaw/skills/ on sync.
    "skills/psd-redrover/",
    "skills/psd-rules/",
    "skills/psd-schedules/",
    "skills/psd-skills-meta/",
    "skills/psd-workspace/",
)

# Filename suffixes that are always runtime cruft. SQLite WAL/SHM files are
# deliberately excluded in BOTH directions: copying sidecars independently
# while the gateway is live produced mismatched database generations in S3.
# The wrapper now stops the gateway and checkpoints the main database before
# every push.
_SKIP_SUFFIXES = (
    ".sock",
    ".pid",
    ".sqlite-wal",
    ".sqlite-shm",
    ".sqlite-journal",
)
_SKIP_BASENAMES = frozenset({
    ".reindex-lock.sqlite",
    "plugins.sync.lock",
})

# Directory names that hold REGENERABLE build artifacts, matched at ANY depth.
#
# These are not memory. They are dependency trees a skill can rebuild from its
# manifest, and round-tripping them through S3 costs real time on every cold
# start: on 2026-07-27 one workspace held 4,989 objects of which 3,886 (77.9%)
# were a pip virtualenv inside a single skill, and the restore took 161.7s
# before the agent could answer its first message. Actual memory/ was 55 files.
#
# Matched per path SEGMENT rather than as a prefix, because they appear
# mid-path — e.g. skills/<name>/.tts-venv/lib/python3.11/site-packages/pip/...
# — which the prefix list above cannot express.
_SKIP_SEGMENT_NAMES = frozenset({
    "node_modules",
    "site-packages",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".turbo",
    ".next",
})


def _is_regenerable_segment(segment: str) -> bool:
    """True for a directory that can be rebuilt and need not be synced."""
    if segment in _SKIP_SEGMENT_NAMES:
        return True
    # Virtualenvs: exact "venv"/".venv", plus HIDDEN skill-local forms like
    # ".tts-venv". The "-venv" suffix is deliberately not honoured on visible
    # segments: an authored directory such as
    # "skills/user/hagelk-python-venv/SKILL.md" would then be skipped by BOTH
    # the pull and the push, so the agent's own scratch space would be neither
    # restored nor uploaded. The two failure modes are not symmetric — an
    # unmatched venv only costs sync time, an over-matched skill loses work —
    # so keep the match narrow and let a stray visible venv ride along.
    if segment in ("venv", ".venv"):
        return True
    return segment.startswith(".") and segment.endswith("-venv")


# Legacy session transcripts.
#
# OpenClaw 2026.7 imports these JSONL files into the per-agent SQLite database.
# The FIRST restore must therefore download every legacy transcript so no
# history is omitted from the import. After the durable marker above exists,
# future cold boots restore the SQLite database and leave the legacy archive in
# versioned S3 instead of re-downloading hundreds of megabytes.
#
def _is_legacy_session_path(relative: str) -> bool:
    parts = Path(relative.lstrip("/")).parts
    return (
        len(parts) >= 3
        and parts[0] == "agents"
        and parts[2] == "sessions"
    )


def _is_imported_legacy_state(relative: str) -> bool:
    """Return True for a source object already represented in SQLite."""
    rel = relative.lstrip("/")
    return (
        _is_legacy_session_path(rel)
        or rel == "openclaw-workspace-state.json"
        or rel.startswith("workspace-attestations/")
        or rel.endswith(".doctor-importing")
    )


def _should_skip_relative(relative: str) -> bool:
    """True if this workspace-relative path is gateway-owned, not user memory."""
    rel = relative.lstrip("/")
    for prefix in _SKIP_RELATIVE_PREFIXES:
        if rel == prefix or rel.startswith(prefix):
            return True
    if Path(rel).name in _SKIP_BASENAMES:
        return True
    if any(_is_regenerable_segment(seg) for seg in rel.split("/")):
        return True
    return any(rel.endswith(suf) for suf in _SKIP_SUFFIXES)


def _should_skip(path: Path) -> bool:
    """Path-based wrapper for push-side filtering."""
    try:
        relative = path.relative_to(WORKSPACE_DIR).as_posix()
    except ValueError:
        return False
    return _should_skip_relative(relative)


def _open_regular_no_follow(relative: str):
    """Open a workspace file through no-follow dirfds.

    Model-created symlinks must never turn workspace persistence into a reader
    for invocation credentials, image-owned files, or host configuration.
    """
    parts = Path(relative).parts
    if (
        not parts
        or any(part in ("", ".", "..") for part in parts)
        or Path(relative).is_absolute()
    ):
        raise OSError("invalid workspace file path")
    directory_fd = os.open(
        WORKSPACE_DIR,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        for part in parts[:-1]:
            next_fd = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            os.close(directory_fd)
            directory_fd = next_fd
        file_fd = os.open(
            parts[-1],
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
    finally:
        os.close(directory_fd)
    metadata = os.fstat(file_fd)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(file_fd)
        raise OSError("workspace entry is not a regular file")
    return os.fdopen(file_fd, "rb"), metadata


def _remaining_timeout(
    deadline_monotonic: float | None,
    maximum_seconds: float,
) -> float:
    """Return a positive operation timeout bounded by an optional deadline."""
    if deadline_monotonic is None:
        return maximum_seconds
    remaining = deadline_monotonic - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("workspace sync deadline exceeded")
    return min(maximum_seconds, remaining)


def _broker_request(
    payload: dict,
    deadline_monotonic: float | None = None,
) -> dict:
    """Call the trusted storage broker with the opaque signed owner context."""
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    headers.update(_workspace_flush_headers())
    request = urllib.request.Request(
        "http://127.0.0.1:18791/agent-broker/api/agent/workspace-storage",
        data=body,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=_remaining_timeout(deadline_monotonic, 20),
        ) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"workspace broker HTTP {exc.code}: {detail}"
        ) from exc
    if not isinstance(result, dict):
        raise RuntimeError("workspace broker returned invalid JSON")
    return result


def _workspace_flush_headers() -> dict[str, str]:
    """Return root-only final-flush authority, never model-readable state."""
    if os.geteuid() != 0:
        return {}
    try:
        token = Path(WORKSPACE_FLUSH_TOKEN_PATH).read_text(
            encoding="ascii"
        ).strip()
    except FileNotFoundError:
        return {}
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise RuntimeError("workspace flush authority is malformed")
    return {"X-Agent-Workspace-Flush": token}


def _download_spec(relative: str) -> tuple[str, int, dict[str, str]]:
    result = _broker_request({"operation": "download", "path": relative})
    url = result.get("downloadUrl")
    content_length = result.get("contentLength")
    required_headers = result.get("requiredHeaders")
    if (
        not isinstance(url, str)
        or not isinstance(content_length, int)
        or isinstance(content_length, bool)
        or content_length < 1
        or content_length > MAX_SYNC_FILE_BYTES
        or not isinstance(required_headers, dict)
        or required_headers.get("Range") != f"bytes=0-{content_length - 1}"
    ):
        raise RuntimeError("workspace broker returned an invalid bounded download")
    return url, content_length, {"Range": required_headers["Range"]}


def _upload_spec(
    relative: str,
    content_length: int,
    idempotency_key: str,
    checksum_sha256: str,
    deadline_monotonic: float | None = None,
) -> Optional[tuple[str, str, dict[str, str]]]:
    result = _broker_request({
        "operation": "upload",
        "path": relative,
        "contentType": WORKSPACE_UPLOAD_CONTENT_TYPE,
        "contentLength": content_length,
        "idempotencyKey": idempotency_key,
        "checksumSha256": checksum_sha256,
    }, deadline_monotonic)
    url = result.get("uploadUrl")
    if result.get("unchanged") is True and isinstance(result.get("key"), str):
        return None
    reservation_id = result.get("reservationId")
    required_headers = result.get("requiredHeaders")
    if (
        not isinstance(url, str)
        or not isinstance(reservation_id, str)
        or not isinstance(required_headers, dict)
        or set(required_headers) != {
            "Content-Length",
            "Content-Type",
            "x-amz-checksum-sha256",
        }
        or required_headers.get("Content-Length") != str(content_length)
        or required_headers.get("Content-Type") != WORKSPACE_UPLOAD_CONTENT_TYPE
        or required_headers.get("x-amz-checksum-sha256") != checksum_sha256
    ):
        raise RuntimeError("workspace broker returned no bounded upload")
    return url, reservation_id, {
        "Content-Length": str(content_length),
        "Content-Type": WORKSPACE_UPLOAD_CONTENT_TYPE,
        "x-amz-checksum-sha256": checksum_sha256,
    }


def _download_bounded(
    url: str,
    destination: Path,
    content_length: int,
    required_headers: dict[str, str],
) -> None:
    request = urllib.request.Request(url, headers=required_headers)
    written = 0
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response_length = response.headers.get("Content-Length")
            if response_length is not None:
                if not response_length.isdigit() or int(response_length) != content_length:
                    raise RuntimeError("workspace download length mismatch")
            with destination.open("wb") as output:
                while True:
                    chunk = response.read(TRANSFER_CHUNK_BYTES)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > content_length:
                        raise RuntimeError("workspace download exceeded declared length")
                    output.write(chunk)
        if written != content_length:
            raise RuntimeError("workspace download ended before declared length")
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def _stream_upload(
    url: str,
    relative: str,
    content_length: int,
    required_headers: dict[str, str],
    deadline_monotonic: float | None = None,
) -> None:
    parsed = urllib.parse.urlsplit(url)
    local_http = parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "localhost",
    }
    if parsed.scheme != "https" and not local_http:
        raise RuntimeError("workspace upload URL must use HTTPS")
    connection_type = (
        http.client.HTTPSConnection if parsed.scheme == "https"
        else http.client.HTTPConnection
    )
    connection = connection_type(
        parsed.hostname,
        parsed.port,
        timeout=_remaining_timeout(deadline_monotonic, 60),
    )
    target = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
    try:
        connection.putrequest("PUT", target)
        for name, value in required_headers.items():
            connection.putheader(name, value)
        connection.endheaders()
        sent = 0
        source, metadata = _open_regular_no_follow(relative)
        if metadata.st_size != content_length:
            source.close()
            raise RuntimeError("workspace file changed during upload")
        with source:
            while True:
                _remaining_timeout(deadline_monotonic, 60)
                chunk = source.read(TRANSFER_CHUNK_BYTES)
                if not chunk:
                    break
                sent += len(chunk)
                if sent > content_length:
                    raise RuntimeError("workspace file changed during upload")
                connection.send(chunk)
        if sent != content_length:
            raise RuntimeError("workspace file changed during upload")
        response = connection.getresponse()
        response.read(TRANSFER_CHUNK_BYTES)
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"workspace upload HTTP {response.status}")
    finally:
        connection.close()


def pull_workspace(prefix: str) -> int:
    """Restore /home/node/.openclaw/ through the owner-bound storage broker.

    Parallelized via ThreadPoolExecutor — a serial loop over 10k+ files
    takes 10–15 minutes on a cold microVM, which pushes every cron Lambda
    invocation past its 5-minute timeout and every first-message DM past
    the router Lambda's practical latency budget. 24 concurrent workers
    brings a 10k-file pull to ~30–60s while staying well under Python's
    thread/GIL and S3's per-prefix request limits.

    Failures on individual files are logged while the remaining downloads
    continue, then the restore raises WorkspaceRestoreIncomplete. This gathers
    useful diagnostics without ever treating a partial tree as writable.
    """
    if not prefix:
        return 0

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # Collect the complete listing before choosing downloads. The durable
    # migration marker sorts after agents/* in S3, so deciding page-by-page can
    # mistakenly trim the very JSONL history a first-time migration needs.
    listed_paths: list[str] = []
    skipped = 0
    truncated = False
    continuation = None
    # Resolve the workspace root once so every destination can be checked for
    # containment against it (REV-COR-358 / Zip-Slip). WORKSPACE_DIR was just
    # mkdir'd above, so .resolve() yields its real absolute path.
    workspace_root = WORKSPACE_DIR.resolve()
    while True:
        request_payload = {"operation": "list"}
        if continuation:
            request_payload["continuationToken"] = continuation
        page = _broker_request(request_payload)
        paths = page.get("paths", [])
        if not isinstance(paths, list):
            raise RuntimeError("workspace broker returned invalid path list")
        for relative in paths:
            if not isinstance(relative, str):
                continue
            if not relative:
                continue
            if len(listed_paths) >= MAX_SYNC_FILES:
                logger.error(
                    "workspace restore hit the file-count backstop (%d) — "
                    "restore is INCOMPLETE and push will be disabled",
                    MAX_SYNC_FILES,
                )
                truncated = True
                break
            listed_paths.append(relative)
        if truncated:
            break
        continuation = page.get("continuationToken")
        if not isinstance(continuation, str) or not continuation:
            break

    migration_complete = OPENCLAW_MIGRATION_MARKER in listed_paths
    to_download: list[tuple[str, Path]] = []
    for relative in listed_paths:
        if migration_complete and _is_imported_legacy_state(relative):
            skipped += 1
            continue
        if _should_skip_relative(relative):
            # Gateway-owned config, telemetry, or SQLite transient state.
            # Never let S3 override the image config or pair a main database
            # with a WAL/SHM file from another point in time.
            skipped += 1
            continue
        # Path-traversal guard (REV-COR-358): S3 keys are attacker-
        # influencable — each user's prefix round-trips through
        # agent-writable state — so a key with ".." segments could
        # otherwise resolve outside WORKSPACE_DIR and let a restore write
        # arbitrary files. Reject ".." segments outright, then verify the
        # resolved destination stays inside the workspace root. Skip-and-
        # warn (do not abort the whole pull), matching per-file failure
        # handling.
        if ".." in Path(relative).parts:
            logger.warning("workspace pull skip (path escape) %s", relative)
            skipped += 1
            continue
        dest = (WORKSPACE_DIR / relative).resolve()
        try:
            dest.relative_to(workspace_root)
        except ValueError:
            logger.warning("workspace pull skip (path escape) %s", relative)
            skipped += 1
            continue
        to_download.append((relative, dest))

    from concurrent.futures import ThreadPoolExecutor

    total_bytes = 0
    total_lock = threading.Lock()

    def _download_one(item: tuple[str, Path]) -> Optional[str]:
        nonlocal total_bytes
        relative, dest = item
        try:
            url, content_length, required_headers = _download_spec(relative)
            with total_lock:
                if total_bytes + content_length > MAX_SYNC_TOTAL_BYTES:
                    # Never raise here: an aborted restore leaves image
                    # defaults in place and a later push then overwrites the
                    # user's real files. Skip this one file, keep going, and
                    # let pull_workspace mark the restore incomplete so the
                    # caller suppresses the push.
                    logger.error(
                        "workspace restore hit the aggregate byte backstop — "
                        "restore INCOMPLETE, push will be disabled",
                    )
                    return f"{relative}: aggregate byte backstop"
                total_bytes += content_length
            _download_workspace_file(
                url,
                dest,
                workspace_root,
                content_length,
                required_headers,
            )
            return None
        except Exception as exc:  # noqa: BLE001
            return f"{relative}: {exc}"

    count = 0
    download_errors: list[str] = []
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
        for err in pool.map(_download_one, to_download):
            if err is None:
                count += 1
            else:
                logger.warning("workspace pull skip %s", err)
                download_errors.append(err)
    elapsed = time.monotonic() - started

    if truncated or download_errors:
        # A partial local tree must never become a new remote generation. The
        # caller suppresses every push and retries on the next invocation.
        reason = (
            f"truncated at {MAX_SYNC_FILES} files"
            if truncated
            else f"{len(download_errors)} object download(s) failed"
        )
        raise WorkspaceRestoreIncomplete(
            f"restore incomplete ({reason}) for prefix {prefix}"
        )

    logger.info(
        "workspace pull: prefix=%s files=%d skipped=%d migrated=%s elapsed_s=%.1f",
        prefix, count, skipped, migration_complete, elapsed,
    )
    return count


def openclaw_migration_complete() -> bool:
    """Return whether this hydrated workspace has crossed the SQLite boundary."""
    marker = WORKSPACE_DIR / OPENCLAW_MIGRATION_MARKER
    try:
        return marker.is_file() and marker.read_bytes() == (
            _OPENCLAW_MIGRATION_MARKER_BYTES
        )
    except OSError:
        return False


def mark_openclaw_migration_complete() -> None:
    """Atomically mark a verified migration without deleting legacy S3 data."""
    marker = WORKSPACE_DIR / OPENCLAW_MIGRATION_MARKER
    marker.parent.mkdir(parents=True, exist_ok=True)
    workspace_metadata = WORKSPACE_DIR.stat()
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{marker.name}.",
        dir=marker.parent,
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(_OPENCLAW_MIGRATION_MARKER_BYTES)
            output.flush()
            os.fsync(output.fileno())
            os.fchown(
                output.fileno(),
                workspace_metadata.st_uid,
                workspace_metadata.st_gid,
            )
            os.fchmod(output.fileno(), 0o600)
        os.replace(temporary_name, marker)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def prepare_sqlite_snapshot() -> int:
    """Checkpoint and validate every persisted OpenClaw database.

    The gateway MUST be stopped before this runs. A failed checkpoint or
    integrity check aborts the subsequent push, preserving the last known-good
    remote database rather than replacing it with a torn generation.
    """
    candidates = [WORKSPACE_DIR / "state" / "openclaw.sqlite"]
    candidates.extend(
        (WORKSPACE_DIR / "agents").glob("*/agent/openclaw-agent.sqlite")
    )
    checked = 0
    workspace_root = WORKSPACE_DIR.resolve()
    for database in candidates:
        if not database.exists():
            continue
        resolved = database.resolve()
        try:
            resolved.relative_to(workspace_root)
        except ValueError as exc:
            raise RuntimeError("SQLite database escaped workspace root") from exc
        if resolved != database.absolute():
            raise RuntimeError("SQLite database path contains a symlink")
        with sqlite3.connect(str(database), timeout=30) as connection:
            checkpoint = connection.execute(
                "PRAGMA wal_checkpoint(TRUNCATE)"
            ).fetchone()
            if checkpoint is None or int(checkpoint[0]) != 0:
                raise RuntimeError(
                    f"SQLite checkpoint remained busy for {database.name}"
                )
            integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise RuntimeError(
                f"SQLite integrity check failed for {database.name}"
            )
        checked += 1
    logger.info("workspace SQLite snapshot prepared: databases=%d", checked)
    return checked


def pull_files(prefix: str, relative_paths: list) -> int:
    """Download specific workspace-relative files from s3://bucket/prefix/.

    Per-turn attachment delivery (issue #1138 F1): the router uploads Chat
    attachment bytes to s3://bucket/<prefix>/attachments/... at message time,
    which is AFTER this microVM's one-time pull_workspace() ran — a warm
    microVM would never see them. This fetches just the named keys so the
    files exist at /home/node/.openclaw/<relative_path> before the turn.

    Refuses paths that escape the workspace dir (traversal) or that map to
    gateway-owned config (_should_skip_relative) — the relative paths arrive
    from the router payload, so treat them as untrusted input. Failures on
    individual files are logged and skipped; returns the count downloaded.
    """
    if not prefix or not relative_paths:
        return 0

    workspace_root = WORKSPACE_DIR.resolve()
    pulled = 0
    total_bytes = 0
    for rel in relative_paths:
        if pulled >= MAX_SYNC_FILES:
            logger.warning("pull_files: file-count limit reached")
            break
        if not isinstance(rel, str) or not rel:
            continue
        rel = rel.lstrip("/")
        dest = (WORKSPACE_DIR / rel).resolve()
        if not dest.is_relative_to(workspace_root):
            logger.warning("pull_files: refusing path outside workspace: %s", rel)
            continue
        if _should_skip_relative(rel):
            logger.warning("pull_files: refusing gateway-owned path: %s", rel)
            continue
        try:
            url, content_length, required_headers = _download_spec(rel)
            if total_bytes + content_length > MAX_SYNC_TOTAL_BYTES:
                logger.warning("pull_files: aggregate byte limit reached")
                break
            total_bytes += content_length
            _download_workspace_file(
                url,
                dest,
                workspace_root,
                content_length,
                required_headers,
            )
            pulled += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("pull_files: failed %s: %s", rel, str(exc)[:200])

    logger.info(
        "pull_files: prefix=%s requested=%d pulled=%d",
        prefix, len(relative_paths), pulled,
    )
    return pulled


def _iter_workspace_files(
    deadline_monotonic: float | None = None,
):
    """Yield bounded regular-file paths without following any symlink.

    The traversal is rooted in an O_NOFOLLOW directory descriptor, and every
    visited entry consumes the same global budget whether or not it is safe or
    uploadable. This makes symlink farms and special-file farms cheap to reject.
    """
    def _open_directory(relative: str) -> int:
        parts = Path(relative).parts if relative else ()
        if len(parts) > MAX_SYNC_DEPTH:
            raise OSError("workspace directory depth limit exceeded")
        directory_fd = os.open(
            WORKSPACE_DIR,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        try:
            for part in parts:
                _remaining_timeout(deadline_monotonic, 60)
                next_fd = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
                os.close(directory_fd)
                directory_fd = next_fd
            return directory_fd
        except Exception:
            os.close(directory_fd)
            raise

    stack: list[str] = [""]
    visited = 0
    while stack:
        relative_directory = stack.pop()
        try:
            directory_fd = _open_directory(relative_directory)
        except TimeoutError:
            raise
        except OSError as exc:
            logger.warning(
                "workspace push skip unsafe directory %s: %s",
                relative_directory or ".",
                exc,
            )
            continue
        try:
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    _remaining_timeout(deadline_monotonic, 60)
                    visited += 1
                    if visited > MAX_SYNC_ENTRIES:
                        logger.warning(
                            "workspace push entry-count limit reached"
                        )
                        return
                    relative = (
                        f"{relative_directory}/{entry.name}"
                        if relative_directory
                        else entry.name
                    )
                    if _should_skip_relative(relative):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if len(Path(relative).parts) <= MAX_SYNC_DEPTH:
                                stack.append(relative)
                            else:
                                logger.warning(
                                    "workspace push skip over-deep directory %s",
                                    relative,
                                )
                        elif entry.is_file(follow_symlinks=False):
                            yield relative
                        else:
                            logger.warning(
                                "workspace push skip unsafe entry %s",
                                relative,
                            )
                    except OSError as exc:
                        logger.warning(
                            "workspace push skip unsafe entry %s: %s",
                            relative,
                            exc,
                        )
        finally:
            os.close(directory_fd)


def push_workspace(
    prefix: str,
    deadline_monotonic: float | None = None,
) -> int:
    """Upload current /home/node/.openclaw/ contents to s3://bucket/prefix/."""
    if not prefix:
        return 0
    # Parallelized for the same reason as pull: 10k+ files over a serial
    # upload blocks both the idle-push background thread and the final
    # shutdown flush, so state can be lost if the microVM is torn down
    # mid-push.
    to_upload: list[tuple[str, str, int, int, str]] = []
    total_bytes = 0
    for relative in _iter_workspace_files(deadline_monotonic):
        path = WORKSPACE_DIR / relative
        try:
            source, metadata = _open_regular_no_follow(relative)
        except OSError as exc:
            logger.warning("workspace push skip unsafe file %s: %s", relative, exc)
            continue
        if metadata.st_size < 1:
            source.close()
            continue
        if metadata.st_size > MAX_SYNC_FILE_BYTES:
            source.close()
            logger.warning("workspace push skip oversized file %s", relative)
            continue
        signature = (metadata.st_size, metadata.st_mtime_ns)
        state_key = (prefix, relative)
        if _uploaded_state.get(state_key) == signature:
            source.close()
            continue
        if len(to_upload) >= MAX_SYNC_FILES:
            source.close()
            logger.warning("workspace push file-count limit reached")
            break
        if total_bytes + metadata.st_size > MAX_SYNC_TOTAL_BYTES:
            source.close()
            logger.warning("workspace push aggregate byte limit reached")
            break
        total_bytes += metadata.st_size
        digest = hashlib.sha256()
        with source:
            while True:
                _remaining_timeout(deadline_monotonic, 60)
                chunk = source.read(TRANSFER_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
        to_upload.append(
            (
                str(path),
                relative,
                metadata.st_size,
                metadata.st_mtime_ns,
                base64.b64encode(digest.digest()).decode("ascii"),
            )
        )

    from concurrent.futures import ThreadPoolExecutor

    def _upload_one(pair: tuple[str, str, int, int, str]) -> Optional[str]:
        path, relative, content_length, modified_ns, checksum_sha256 = pair
        try:
            prepared = _upload_spec(
                relative,
                content_length,
                str(uuid.uuid4()),
                checksum_sha256,
                deadline_monotonic,
            )
            if prepared is None:
                _uploaded_state[(prefix, relative)] = (
                    content_length,
                    modified_ns,
                )
                return None
            upload_url, reservation_id, required_headers = prepared
            _stream_upload(
                upload_url,
                relative,
                content_length,
                required_headers,
                deadline_monotonic,
            )
            completed = _broker_request({
                "operation": "complete-upload",
                "reservationId": reservation_id,
            }, deadline_monotonic)
            if not isinstance(completed.get("key"), str):
                raise RuntimeError("workspace broker did not verify upload")
            _uploaded_state[(prefix, relative)] = (
                content_length,
                modified_ns,
            )
            return None
        except Exception as exc:  # noqa: BLE001
            return f"{path}: {exc}"

    count = 0
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
        for err in pool.map(_upload_one, to_upload):
            if err is None:
                count += 1
            else:
                logger.warning("workspace push skip %s", err)
    elapsed = time.monotonic() - started

    logger.info(
        "workspace push: prefix=%s files=%d elapsed_s=%.1f",
        prefix, count, elapsed,
    )
    return count
