"""
Workspace sync — persists OpenClaw's local state through the owner-bound web
storage broker so the agent has
long-term memory across microVM lifecycles.

OpenClaw stores per-user state under /home/node/.openclaw/ (canvases,
preferences, cached artifacts). AgentCore microVMs are ephemeral, so without
syncing this directory the agent forgets everything between idle-timeouts and
deploys.

This module gives the wrapper three operations:
  - pull_workspace(prefix): on first invocation per microVM, restore the user's
    /home/node/.openclaw/ from the signed invocation context's workspace prefix
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
import http.client
import base64
import hashlib
import json
import os
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

WORKSPACE_DIR = Path("/home/node/.openclaw")
MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024
MAX_SYNC_TOTAL_BYTES = 256 * 1024 * 1024
MAX_SYNC_FILES = 1_000
SYNC_WORKERS = 4
TRANSFER_CHUNK_BYTES = 64 * 1024
WORKSPACE_UPLOAD_CONTENT_TYPE = "application/octet-stream"
_uploaded_state: dict[tuple[str, str], tuple[int, int]] = {}


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
    "skills/psd-redrover/",
    "skills/psd-rules/",
    "skills/psd-schedules/",
    "skills/psd-skills-meta/",
    "skills/psd-workspace/",
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


def _broker_request(payload: dict) -> dict:
    """Call the trusted storage broker with the opaque signed owner context."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:18791/agent-broker/api/agent/workspace-storage",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"workspace broker HTTP {exc.code}: {detail}"
        ) from exc
    if not isinstance(result, dict):
        raise RuntimeError("workspace broker returned invalid JSON")
    return result


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
) -> Optional[tuple[str, str, dict[str, str]]]:
    result = _broker_request({
        "operation": "upload",
        "path": relative,
        "contentType": WORKSPACE_UPLOAD_CONTENT_TYPE,
        "contentLength": content_length,
        "idempotencyKey": idempotency_key,
        "checksumSha256": checksum_sha256,
    })
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
    connection = connection_type(parsed.hostname, parsed.port, timeout=60)
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

    Failures on individual files are logged as warnings and skipped — the
    pull continues so a single corrupt object doesn't break the whole
    restore.
    """
    if not prefix:
        return 0

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # Collect paths first, then obtain short-lived download URLs in each worker.
    to_download: list[tuple[str, Path]] = []
    skipped = 0
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
            if _should_skip_relative(relative):
                # Gateway-owned config or telemetry. Never let S3 state
                # override the image-provided version.
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
            if len(to_download) >= MAX_SYNC_FILES:
                raise RuntimeError("workspace restore exceeds the file-count limit")
            to_download.append((relative, dest))
        continuation = page.get("continuationToken")
        if not isinstance(continuation, str) or not continuation:
            break

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
                    raise RuntimeError(
                        "workspace restore exceeds the aggregate byte limit"
                    )
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
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
        for err in pool.map(_download_one, to_download):
            if err is None:
                count += 1
            else:
                logger.warning("workspace pull skip %s", err)
    elapsed = time.monotonic() - started

    logger.info(
        "workspace pull: prefix=%s files=%d skipped_config=%d elapsed_s=%.1f",
        prefix, count, skipped, elapsed,
    )
    return count


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


def push_workspace(prefix: str) -> int:
    """Upload current /home/node/.openclaw/ contents to s3://bucket/prefix/."""
    if not prefix:
        return 0
    if not WORKSPACE_DIR.exists():
        return 0
    if os.geteuid() == 0:
        child_env = {
            key: value
            for key, value in os.environ.items()
            if key not in {
                "AGENT_INVOCATION_SIGNING_SECRET",
                "AGENT_INVOCATION_SIGNING_SECRET_ID",
                "PSD_INVOCATION_CONTEXT_FILE",
                "PSD_INVOCATION_REQUEST_PROOF_KEY_FILE",
            }
        }
        result = subprocess.run(
            [sys.executable, __file__, "--push-as-node", prefix],
            check=False,
            capture_output=True,
            text=True,
            env=child_env,
            user="node",
            group="node",
            extra_groups=[],
            umask=0o077,
            cwd=str(WORKSPACE_DIR),
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"node workspace push failed ({result.returncode}): "
                f"{result.stderr[:500]}"
            )
        try:
            return int(result.stdout.strip())
        except ValueError as exc:
            raise RuntimeError("node workspace push returned invalid output") from exc

    # Parallelized for the same reason as pull: 10k+ files over a serial
    # upload blocks both the idle-push background thread and the final
    # shutdown flush, so state can be lost if the microVM is torn down
    # mid-push.
    to_upload: list[tuple[str, str, int, int, str]] = []
    total_bytes = 0
    for path in WORKSPACE_DIR.rglob("*"):
        if path.is_dir() or _should_skip(path):
            continue
        relative = path.relative_to(WORKSPACE_DIR).as_posix()
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
            )
            if prepared is None:
                _uploaded_state[(prefix, relative)] = (
                    content_length,
                    modified_ns,
                )
                return None
            upload_url, reservation_id, required_headers = prepared
            _stream_upload(
                upload_url, relative, content_length, required_headers
            )
            completed = _broker_request({
                "operation": "complete-upload",
                "reservationId": reservation_id,
            })
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


_periodic_thread: Optional[threading.Thread] = None
# Stop signal for the current periodic-push thread. A fresh Event is created per
# start_periodic_push() and captured in that thread's closure, so stopping and
# restarting the pusher never reuses an already-set Event — which previously left
# a restarted pusher permanently short-circuited (its wait() returned True on the
# first tick, so it exited without ever pushing). See REV-COR-358.
_periodic_stop: Optional[threading.Event] = None


def start_periodic_push(prefix: str, interval_s: int = 120) -> None:
    """Background thread that pushes the workspace every interval_s seconds.

    Restart-safe: each call owns a fresh stop Event captured in its worker
    closure, so a stopped-then-started pusher is always a live thread rather
    than a silently-dead one. This is a no-op only while a pusher is already
    alive.
    """
    global _periodic_thread, _periodic_stop
    if _periodic_thread is not None and _periodic_thread.is_alive():
        return  # already running

    stop = threading.Event()
    _periodic_stop = stop

    def _run():
        while not stop.wait(interval_s):
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
    """Signal the periodic push thread to stop, join it, and reset state so a
    later start_periodic_push() can cleanly restart it. Joining (bounded by a
    timeout so shutdown can't hang forever) avoids a window where the old
    thread is still mid-push_workspace() concurrently with a freshly started
    replacement thread (gemini-code-assist review)."""
    global _periodic_thread
    stop = _periodic_stop
    if stop is not None:
        stop.set()
    if _periodic_thread is not None and _periodic_thread.is_alive():
        _periodic_thread.join(timeout=15)
        if _periodic_thread.is_alive():
            raise RuntimeError(
                "periodic workspace push did not stop before authority change"
            )
    _periodic_thread = None


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--push-as-node":
        raise SystemExit(2)
    sys.stdout.write(str(push_workspace(sys.argv[2])))
