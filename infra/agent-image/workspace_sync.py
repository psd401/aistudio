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
    make a best-effort attempt during graceful shutdown

We intentionally use a flat per-user prefix (no per-session subdir) so curated
owner memory and all isolated OpenClaw thread transcripts survive together.
Conversation identity lives inside OpenClaw; workspace persistence must retain
every conversation without starting competing per-thread filesystem writers.

S3 keys are skipped if they look like ephemeral logs/sockets to avoid pushing
junk that bloats restores.
"""

from __future__ import annotations

import logging
import http.client
import base64
import errno
import hashlib
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("workspace_sync")

class WorkspaceRestoreIncomplete(RuntimeError):
    """Restore did not faithfully reproduce S3.

    The caller MUST NOT push after this: the local tree is missing files that
    still exist remotely, and pushing would overwrite them with stale state or
    image defaults.
    """


class WorkspacePushIncomplete(RuntimeError):
    """One or more local workspace files were not durably persisted."""


class WorkspaceGenerationUnavailable(RuntimeError):
    """The broker could not prove a complete authoritative remote snapshot."""


class WorkspaceGenerationConflict(RuntimeError):
    """The authoritative workspace changed after this microVM hydrated it."""


@dataclass(frozen=True)
class _RemoteWorkspaceSnapshot:
    paths: tuple[str, ...]
    sizes: dict[str, int]
    e_tags: dict[str, str]
    generation: Optional[str]


@dataclass(frozen=True)
class _EnsuredWorkspaceCheckpoint:
    generation: str
    snapshot: Optional[_RemoteWorkspaceSnapshot]
    atomic_checkpoint_commit_version: Optional[int] = None
    checkpoint_finalization_proof: Optional[str] = None


@dataclass(frozen=True)
class _PreparedWorkspaceUpload:
    upload_url: Optional[str]
    reservation_id: Optional[str]
    required_headers: dict[str, str]
    unchanged_e_tag: Optional[str] = None


@dataclass(frozen=True)
class _PendingWorkspaceCompletion:
    reservation_id: str
    relative: str
    content_length: int
    modified_ns: int
    changed_ns: int


@dataclass(frozen=True)
class _AtomicCheckpointFinalizationCapability:
    version: int
    proof: str


@dataclass(frozen=True)
class _PendingAtomicWorkspaceFinalization:
    base_generation: str
    proof: str
    uploads: tuple[_PendingWorkspaceCompletion, ...]
    unchanged_uploads: tuple[tuple[str, int, int, int, str], ...]
    deleted_paths: tuple[str, ...]
    base_entries: tuple[tuple[str, int, str], ...]


@dataclass(frozen=True)
class _FinalizedWorkspaceCheckpoint:
    generation: str
    uploads: tuple[tuple[str, str, str], ...]
    deletions: tuple[tuple[str, bool], ...]


class _WorkspaceBrokerHttpError(RuntimeError):
    """An HTTP rejection whose exact response remains available to callers."""

    def __init__(
        self,
        status: int,
        detail: str,
        error_body: object,
        prior_transient_attempts: int = 0,
    ):
        super().__init__(f"workspace broker HTTP {status}: {detail}")
        self.status = status
        self.error_body = error_body
        self.prior_transient_attempts = prior_transient_attempts


WORKSPACE_DIR = Path("/home/node/.openclaw")


def _workspace_policy_path(module_path: Path) -> Path:
    module_directory = module_path.resolve().parent
    repository_candidate = (
        module_directory.parent.parent
        / "lib"
        / "agent-workspace"
        / "workspace-policy.json"
    )
    image_candidate = module_directory / "workspace_policy.json"
    return (
        repository_candidate
        if repository_candidate.is_file()
        else image_candidate
    )


_WORKSPACE_POLICY_PATH = _workspace_policy_path(Path(__file__))
with _WORKSPACE_POLICY_PATH.open(encoding="utf-8") as _policy_file:
    _WORKSPACE_POLICY = json.load(_policy_file)
if _WORKSPACE_POLICY.get("version") != 1:
    raise RuntimeError("unsupported workspace persistence policy")
_PRIVATE_PATH_POLICY = _WORKSPACE_POLICY["privatePath"]
_CHECKPOINT_EXCLUSIONS = _WORKSPACE_POLICY["checkpointExclusions"]
_IMAGE_SEED_RELATIVES = ("IDENTITY.md", "USER.md", "MEMORY.md")
# Captured before the first owner hydration. If a dirty warm workspace must be
# discarded, these per-image scaffolding files can be restored without
# retaining any model-written bytes that were absent from the committed S3
# checkpoint.
_IMAGE_WORKSPACE_SEEDS = {
    relative: (WORKSPACE_DIR / relative).read_bytes()
    for relative in _IMAGE_SEED_RELATIVES
    if (WORKSPACE_DIR / relative).is_file()
}
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
# The ceiling the BROKER enforces (MAX_PRIVATE_UPLOAD_BYTES in
# lib/agent-workspace/storage-broker.ts). Distinct from MAX_SYNC_FILE_BYTES
# above, which is a runaway-traversal backstop four times larger.
#
# Keeping only the backstop meant the agent happily built batches the broker
# could never accept, with no client-side detection at all: the refusal arrived
# per-file from the web tier as a generic staging error, the finalization
# aborted, and the user was told to "retry after the agent service is repaired"
# — advice that can never work, because the same oversized file is rebuilt on
# every subsequent turn. One owner was hard-down for a day that way
# (prod 2026-09-05). Detect it here, before the batch is built, and say which
# file and how big it is.
#
# Keep in sync with MAX_PRIVATE_UPLOAD_BYTES.
#
# DEPLOY ORDER IS LOAD-BEARING: the web tier must ship a raise BEFORE this image
# does. These are two independently deployed units, and this value is only ever
# safe when it is <= the broker's. Ship the agent first and the pre-check below
# passes a file the broker still refuses at the old ceiling — reproducing the
# exact opaque outage this constant exists to prevent, for the whole rollout
# window. Lowering works in the other order: a stale, smaller value here is
# merely conservative and rejects early with a clear message.
BROKER_PRIVATE_UPLOAD_MAX_BYTES = 512 * 1024 * 1024
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
MAX_SYNC_DEPTH = int(_PRIVATE_PATH_POLICY["maxDepth"])
SYNC_WORKERS = 4
TRANSFER_CHUNK_BYTES = 64 * 1024
WORKSPACE_UPLOAD_CONTENT_TYPE = "application/octet-stream"
_TRANSIENT_READ_RETRY_DELAYS_SECONDS = (0.25, 0.5, 1.0, 2.0)
_TRANSIENT_HTTP_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
# Baseline checkpoint capture may need bounded parallel HEADs for thousands of
# existing objects. Keep it below the load-balancer idle ceiling, but above the
# generic 20-second broker read cap. Checkpoint calls are idempotent and are
# deliberately not auto-retried: a client timeout does not prove the web tier
# stopped working, and overlapping retries would queue behind the same lock.
WORKSPACE_CHECKPOINT_BROKER_TIMEOUT_SECONDS = 240
# Atomic finalization uses the checkpoint manifest and proof instead of
# rescanning once per mutation. Mixed-version and legacy fallback operations
# can still perform generation-fenced scans while holding the broker lock, so
# keep one request alive beyond the generic 20-second read timeout; the
# turn-wide deadline remains the hard upper bound.
WORKSPACE_MUTATION_BROKER_TIMEOUT_SECONDS = 60
MAX_WORKSPACE_FINALIZATION_PROOF_BYTES = 4 * 1024
MAX_WORKSPACE_FINALIZATION_ITEMS = 250_000
WORKSPACE_FLUSH_TOKEN_PATH = (
    "/run/psd-agent-authority/workspace-flush-token"
)
WORKSPACE_SYNC_TOKEN_PATH = (
    "/run/psd-agent-authority/workspace-sync-token"
)
_uploaded_state: dict[tuple[str, str], tuple[int, int, int]] = {}
_remote_workspace_snapshots: dict[str, _RemoteWorkspaceSnapshot] = {}
# The broker's atomic checkpoint manifest is the durable commit boundary for a
# complete turn. Individual S3 target versions are promoted one at a time, so
# their raw generation is not committed until the manifest advances last.
_committed_workspace_generations: dict[str, str] = {}
_atomic_checkpoint_finalization_capabilities: dict[
    str, _AtomicCheckpointFinalizationCapability
] = {}
# When target promotions succeeded but final verification/listing did not, the
# wrapper remains dirty and retries from this broker-returned generation. Do
# not discard it on transient post-commit errors: that would strand a fully
# committed warm runtime with no safe recovery path.
_pending_workspace_generations: dict[str, str] = {}
_pending_workspace_completions: dict[
    str, _PendingWorkspaceCompletion
] = {}
_pending_atomic_workspace_finalizations: dict[
    str, _PendingAtomicWorkspaceFinalization
] = {}
_force_exact_workspace_restores: set[str] = set()

# OpenClaw 2026.7 is SQLite-first. The marker is part of the owner workspace,
# so it survives a microVM shutdown and tells future restores that the legacy
# JSONL/attestation archive has already been imported. The legacy S3 objects
# remain untouched (and the bucket is versioned); they are simply no longer
# downloaded on every cold boot.
OPENCLAW_MIGRATION_MARKER = "state/psd-openclaw-sqlite-migration-v1.json"
_OPENCLAW_MIGRATION_MARKER_BYTES = (
    b'{"version":1,"storage":"openclaw-sqlite","legacyArchivePreserved":true}\n'
)
_SQLITE_TRANSIENT_SIDECAR_SUFFIXES = (
    "-wal",
    "-shm",
    "-journal",
)
_SKIP_BASENAME_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in _CHECKPOINT_EXCLUSIONS["basenamePatterns"]
)


def _matches_skip_basename_pattern(basename: str) -> bool:
    return any(
        pattern.fullmatch(basename)
        for pattern in _SKIP_BASENAME_PATTERNS
    )


def _is_transient_read_error(error: BaseException) -> bool:
    """Return whether an idempotent workspace read is safe to retry."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code in _TRANSIENT_HTTP_STATUSES
    return isinstance(
        error,
        (
            urllib.error.URLError,
            TimeoutError,
            ConnectionError,
            http.client.IncompleteRead,
            http.client.RemoteDisconnected,
        ),
    )


def _workspace_relative_rejection_reason(relative: object) -> str | None:
    """Return the canonical cross-language rejection reason, if any."""
    if not isinstance(relative, str) or not relative:
        return "empty"
    if relative.startswith("/"):
        return "absolute"
    if relative.endswith("/"):
        return "trailing-slash"
    try:
        relative_bytes = relative.encode("utf-8")
    except UnicodeEncodeError:
        return "unsupported-character"
    if len(relative_bytes) > int(_PRIVATE_PATH_POLICY["maxUtf8Bytes"]):
        return "too-long"
    rejected_ranges = _PRIVATE_PATH_POLICY["rejectedCodePointRanges"]
    if any(
        start <= ord(character) <= end
        for character in relative
        for start, end in rejected_ranges
    ):
        return "unsupported-character"

    parts = tuple(relative.split("/"))
    if len(parts) > MAX_SYNC_DEPTH:
        return "too-deep"
    for part in parts:
        if not part:
            return "empty-segment"
        if part in (".", ".."):
            return "traversal-segment"
        if len(part.encode("utf-8")) > int(
            _PRIVATE_PATH_POLICY["maxSegmentUtf8Bytes"]
        ):
            return "segment-too-long"
    return None


def _validate_workspace_relative(relative: str) -> tuple[str, ...]:
    """Return safe lexical path parts without consulting mutable symlinks."""
    if _workspace_relative_rejection_reason(relative) is not None:
        raise OSError("invalid workspace file path")
    return tuple(relative.split("/"))


def _install_workspace_file(source: Path, relative: str) -> None:
    """Atomically install at a literal path without following local symlinks."""
    _validate_workspace_relative(relative)
    writer = r"""
import errno
import os
import re
import stat
import sys
import uuid

root = sys.argv[1]
relative = sys.argv[2]
parts = relative.split("/")
if (
    not relative
    or relative.startswith("/")
    or any(part in ("", ".", "..") for part in parts)
):
    raise OSError("invalid workspace file path")

removed_entries = 0

def remove_entry(parent_fd, name, depth=0):
    global removed_entries
    removed_entries += 1
    if removed_entries > int(sys.argv[4]):
        raise OSError("workspace blocker entry-count limit reached")
    if depth > 64:
        raise OSError("workspace blocker depth limit reached")
    metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return
    child_fd = os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        dir_fd=parent_fd,
    )
    try:
        with os.scandir(child_fd) as entries:
            for entry in entries:
                remove_entry(child_fd, entry.name, depth + 1)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=parent_fd)

def open_or_create_directory(parent_fd, name):
    for _attempt in range(8):
        try:
            metadata = os.stat(
                name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent_fd)
            except FileExistsError:
                pass
            continue
        if not stat.S_ISDIR(metadata.st_mode):
            try:
                os.unlink(name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            except IsADirectoryError:
                pass
            continue
        try:
            return os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
        except OSError as error:
            if error.errno not in (
                errno.ELOOP,
                errno.ENOENT,
                errno.ENOTDIR,
            ):
                raise
    raise OSError("workspace parent remained unstable")

directory_fd = os.open(
    root,
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
)
try:
    for part in parts[:-1]:
        next_fd = open_or_create_directory(directory_fd, part)
        os.close(directory_fd)
        directory_fd = next_fd

    leaf = parts[-1]
    if leaf.endswith(".sqlite"):
        def unlink_transient(name):
            try:
                remove_entry(directory_fd, name)
            except FileNotFoundError:
                return

        sidecar_names = [
            f"{leaf}{suffix}" for suffix in sys.argv[3].split(",")
        ]
        reindex_database_names = [
            ".reindex-lock.sqlite",
            f"{leaf}.reindex-lock.sqlite",
        ]
        sidecar_names.extend(reindex_database_names)
        sidecar_names.extend([
            f"{reindex_database_name}{suffix}"
            for reindex_database_name in reindex_database_names
            for suffix in sys.argv[3].split(",")
        ])
        for sidecar_name in sidecar_names:
            unlink_transient(sidecar_name)
        memory_reindex_prefix = f"{leaf}.memory-reindex-"
        with os.scandir(directory_fd) as siblings:
            for sibling in siblings:
                if re.fullmatch(
                    rf"{re.escape(memory_reindex_prefix)}[0-9A-Fa-f-]+"
                    r"(?:-(?:wal|shm|journal))?",
                    sibling.name,
                ):
                    unlink_transient(sibling.name)

    try:
        leaf_metadata = os.stat(
            leaf,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        leaf_metadata = None
    if leaf_metadata is not None and stat.S_ISDIR(leaf_metadata.st_mode):
        remove_entry(directory_fd, leaf)

    temporary = f".{leaf}.{uuid.uuid4().hex}.tmp"
    temporary_fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        with os.fdopen(temporary_fd, "wb") as output:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        os.replace(
            temporary,
            leaf,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
    finally:
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
finally:
    os.close(directory_fd)
"""
    process: subprocess.Popen[bytes] | None = None
    try:
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
                str(WORKSPACE_DIR),
                relative,
                ",".join(_SQLITE_TRANSIENT_SIDECAR_SUFFIXES),
                str(MAX_SYNC_ENTRIES),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            cwd=str(WORKSPACE_DIR),
            **process_options,
        )
        assert process.stdin is not None
        with source.open("rb") as staged:
            while True:
                chunk = staged.read(TRANSFER_CHUNK_BYTES)
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


def _download_workspace_file(
    source_url: str,
    relative: str,
    content_length: int,
    required_headers: dict[str, str],
) -> None:
    """Restore one exact bounded object without root writing into model state."""
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix="workspace-download-",
        dir="/tmp",
    )
    os.close(temporary_fd)
    temporary_path = Path(temporary_name)
    try:
        for attempt in range(
            len(_TRANSIENT_READ_RETRY_DELAYS_SECONDS) + 1
        ):
            written = 0
            try:
                request = urllib.request.Request(
                    source_url,
                    headers=required_headers,
                )
                with temporary_path.open("wb") as output:
                    with urllib.request.urlopen(
                        request,
                        timeout=60,
                    ) as response:
                        response_length = response.headers.get(
                            "Content-Length"
                        )
                        if response_length is not None and (
                            not response_length.isdigit()
                            or int(response_length) != content_length
                        ):
                            raise RuntimeError(
                                "workspace download length mismatch"
                            )
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
                    raise RuntimeError(
                        "workspace download ended before declared length"
                    )
                break
            except Exception as exc:  # noqa: BLE001
                retryable = _is_transient_read_error(exc)
                if isinstance(exc, urllib.error.HTTPError):
                    exc.close()
                if (
                    not retryable
                    or attempt >= len(_TRANSIENT_READ_RETRY_DELAYS_SECONDS)
                ):
                    raise
                delay = _TRANSIENT_READ_RETRY_DELAYS_SECONDS[attempt]
                logger.warning(
                    "workspace object download retry: path=%s "
                    "attempt=%d/%d delay_s=%.2f error=%s",
                    relative,
                    attempt + 1,
                    len(_TRANSIENT_READ_RETRY_DELAYS_SECONDS) + 1,
                    delay,
                    str(exc)[:160],
                )
                time.sleep(delay)
        _install_workspace_file(temporary_path, relative)
    finally:
        temporary_path.unlink(missing_ok=True)


def _materialize_empty_workspace_file(
    relative: str,
) -> None:
    """Restore a broker-declared empty object without requesting an invalid range."""
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix="workspace-empty-",
        dir="/tmp",
    )
    os.close(temporary_fd)
    temporary_path = Path(temporary_name)
    try:
        _install_workspace_file(temporary_path, relative)
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
# AGENTS.md is NOT on this list today, but only because we are not currently
# writing it — NOT because the host ignores it (2026-08-09).
#
# AGENTS.md IS injected into the system prompt by the host we pin. Verified at
# runtime, not inferred: boot the image with a distinct sentinel in AGENTS.md
# and another in SOUL.md, point a stub `openai-completions` provider at a local
# capture server, run one turn, and read the request body. Both sentinels appear
# in the role=system message, AGENTS.md under its own
# `## /home/node/.openclaw/AGENTS.md` header.
#
# An earlier version of this comment claimed the opposite, citing
# `skipOptionalBootstrapFiles` from `openclaw config schema`. That was wrong:
# the key enumerates only the OPTIONAL bootstrap files, not the complete
# injected set. The injected-file arrays in /app/dist are likewise
# reduced-context allowlists, not the main-session loader. Static reading of a
# minified bundle cannot settle this question — run the capture instead. Use the
# SOUL.md sentinel as the positive control: it is definitively injected, so if
# it does not appear, the method is broken and the result proves nothing.
#
# So the original 2026-08-07 diagnosis was right — sync WAS overwriting
# AGENTS.md and clobbering the rules. Excluding it was the correct fix. It
# failed only on ordering: the first image pushed AGENTS.md to S3 before the
# exclusion existed, which made it a retired-but-present path, and the broker
# then refused every restore with "Retired workspace host state requires
# controlled migration" until the exclusion was reverted.
#
# The rule that follows:
#   Add the sync exclusion in the SAME release that first writes an image-owned
#   file, never after. Excluding a path already in S3 creates a retired path and
#   needs a controlled migration; excluding one that was never pushed is free.
#
# Operating rules currently live appended to SOUL.md, which is on this list and
# works. Moving them into AGENTS.md is a viable optimization, not a fix — doing
# it safely from here costs a workspace cutover, so it stays parked.
#
# Exact paths and prefix paths are separate so retiring one generated control
# file can never hide similarly named user content. The values live in
# workspace_policy.json so the web checkpoint and image runtime cannot
# silently drift into different definitions of durable state.
_SKIP_EXACT_PATHS = frozenset(
    _CHECKPOINT_EXCLUSIONS["exactPaths"]
)
_SKIP_RELATIVE_PREFIXES = tuple(
    _CHECKPOINT_EXCLUSIONS["relativePrefixes"]
)

# Filename suffixes that are always runtime cruft. SQLite WAL/SHM files are
# deliberately excluded in BOTH directions: copying sidecars independently
# while the gateway is live produced mismatched database generations in S3.
# The wrapper now stops the gateway and checkpoints the main database before
# every push.
_SKIP_SUFFIXES = tuple(_CHECKPOINT_EXCLUSIONS["suffixes"])
_SKIP_BASENAMES = frozenset(_CHECKPOINT_EXCLUSIONS["basenames"])

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
_SKIP_SEGMENT_NAMES = frozenset(
    _CHECKPOINT_EXCLUSIONS["segmentNames"]
)
_EXACT_VENV_SEGMENTS = frozenset(
    _CHECKPOINT_EXCLUSIONS["exactVenvSegments"]
)
_HIDDEN_VENV_SUFFIX = str(
    _CHECKPOINT_EXCLUSIONS["hiddenVenvSuffix"]
)


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
    if segment in _EXACT_VENV_SEGMENTS:
        return True
    return segment.startswith(".") and segment.endswith(_HIDDEN_VENV_SUFFIX)


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


def _is_generated_session_import_archive(relative: str) -> bool:
    """True for OpenClaw's redundant post-import JSONL archive copies."""
    parts = Path(relative.lstrip("/")).parts
    return (
        len(parts) >= 3
        and parts[0] == "agents"
        and parts[2] == "session-sqlite-import-archive"
    )


def _is_imported_legacy_state(relative: str) -> bool:
    """Return True for a source object already represented in SQLite."""
    rel = relative.lstrip("/")
    return (
        _is_legacy_session_path(rel)
        or _is_generated_session_import_archive(rel)
        or rel == "openclaw-workspace-state.json"
        or rel.startswith("workspace-attestations/")
        or rel.endswith(".doctor-importing")
    )


def _should_skip_relative(relative: str) -> bool:
    """True if this workspace-relative path is gateway-owned, not user memory."""
    rel = relative.lstrip("/")
    if rel in _SKIP_EXACT_PATHS:
        return True
    for prefix in _SKIP_RELATIVE_PREFIXES:
        if rel == prefix or rel.startswith(prefix):
            return True
    basename = rel.split("/")[-1]
    if basename in _SKIP_BASENAMES:
        return True
    if _matches_skip_basename_pattern(basename):
        return True
    if any(_is_regenerable_segment(seg) for seg in rel.split("/")):
        return True
    return any(rel.endswith(suf) for suf in _SKIP_SUFFIXES)


def _is_checkpoint_managed_relative(relative: str) -> bool:
    """True only for mutable state represented by the atomic checkpoint."""
    return (
        relative != "attachments"
        and not relative.startswith("attachments/")
        and not _should_skip_relative(relative)
    )


def _preserve_image_owned_relative(relative: str) -> bool:
    """Keep deployed/gateway paths while pruning a dirty warm workspace."""
    rel = relative.lstrip("/")
    return (
        any(
            rel == prefix or rel.startswith(prefix)
            for prefix in _SKIP_RELATIVE_PREFIXES
        )
        or rel.split("/")[-1] in _SKIP_BASENAMES
        or any(_is_regenerable_segment(part) for part in rel.split("/"))
    )


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


def invalidate_local_workspace(prefix: str) -> None:
    """Force the next refresh to discard an uncommitted warm local tree."""
    if not prefix:
        return
    _remote_workspace_snapshots.pop(prefix, None)
    _committed_workspace_generations.pop(prefix, None)
    _atomic_checkpoint_finalization_capabilities.pop(prefix, None)
    _pending_workspace_generations.pop(prefix, None)
    _pending_workspace_completions.pop(prefix, None)
    _pending_atomic_workspace_finalizations.pop(prefix, None)
    for state_key in [
        key for key in _uploaded_state if key[0] == prefix
    ]:
        _uploaded_state.pop(state_key, None)
    _force_exact_workspace_restores.add(prefix)


def _unlink_workspace_regular_no_follow(relative: str) -> None:
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
        metadata = os.stat(
            parts[-1],
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("workspace entry is not a regular file")
        os.unlink(parts[-1], dir_fd=directory_fd)
    finally:
        os.close(directory_fd)


def _restore_image_seed(relative: str, content: bytes) -> None:
    destination = WORKSPACE_DIR / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    workspace_metadata = WORKSPACE_DIR.stat()
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        dir=destination.parent,
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            os.fchown(
                output.fileno(),
                workspace_metadata.st_uid,
                workspace_metadata.st_gid,
            )
            os.fchmod(output.fileno(), 0o600)
        os.replace(temporary_name, destination)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def _remove_workspace_entry_no_follow(
    parent_fd: int,
    name: str,
    depth: int = 0,
    deadline_monotonic: float | None = None,
    visited: list[int] | None = None,
) -> None:
    """Remove one local entry without following any symlink in its tree."""
    _remaining_timeout(deadline_monotonic, 60)
    if visited is None:
        visited = [0]
    visited[0] += 1
    if visited[0] > MAX_SYNC_ENTRIES:
        raise WorkspaceRestoreIncomplete(
            "exact restore blocker entry-count limit reached"
        )
    if depth > MAX_SYNC_DEPTH:
        raise WorkspaceRestoreIncomplete(
            "exact restore blocker depth limit reached"
        )
    metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return

    directory_fd = os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        dir_fd=parent_fd,
    )
    try:
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                _remove_workspace_entry_no_follow(
                    directory_fd,
                    entry.name,
                    depth + 1,
                    deadline_monotonic,
                    visited,
                )
    finally:
        os.close(directory_fd)
    os.rmdir(name, dir_fd=parent_fd)


def _discard_retired_local_control_state(
    deadline_monotonic: float | None = None,
) -> None:
    """Remove retired exact host-state paths before OpenClaw can probe them.

    These paths are neither image-owned nor user history. Pinned OpenClaw
    refuses to start while either one exists, so a contaminated warm microVM
    must not preserve them merely because checkpoint sync excludes them.
    """
    workspace_fd = os.open(
        WORKSPACE_DIR,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        for relative in sorted(_SKIP_EXACT_PATHS):
            _remaining_timeout(deadline_monotonic, 60)
            parts = Path(relative).parts
            if len(parts) != 1 or parts[0] in ("", ".", ".."):
                raise WorkspaceRestoreIncomplete(
                    "retired control-state path is not root-relative"
                )
            try:
                _remove_workspace_entry_no_follow(
                    workspace_fd,
                    parts[0],
                    deadline_monotonic=deadline_monotonic,
                )
            except FileNotFoundError:
                continue
    finally:
        os.close(workspace_fd)


def _prepare_committed_remote_parents(
    remote_paths: set[str],
    deadline_monotonic: float | None = None,
) -> None:
    """Prepare exact committed destinations without following local links."""
    workspace_fd = os.open(
        WORKSPACE_DIR,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        for relative in sorted(remote_paths):
            _remaining_timeout(deadline_monotonic, 60)
            if (
                relative == "attachments"
                or relative.startswith("attachments/")
                or _should_skip_relative(relative)
            ):
                continue
            try:
                parts = _validate_workspace_relative(relative)
            except OSError:
                continue
            directory_fd = os.dup(workspace_fd)
            try:
                for part in parts[:-1]:
                    created = False
                    try:
                        metadata = os.stat(
                            part,
                            dir_fd=directory_fd,
                            follow_symlinks=False,
                        )
                    except FileNotFoundError:
                        os.mkdir(part, mode=0o700, dir_fd=directory_fd)
                        created = True
                        metadata = os.stat(
                            part,
                            dir_fd=directory_fd,
                            follow_symlinks=False,
                        )
                    if not stat.S_ISDIR(metadata.st_mode):
                        os.unlink(part, dir_fd=directory_fd)
                        os.mkdir(part, mode=0o700, dir_fd=directory_fd)
                        created = True
                    next_fd = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=directory_fd,
                    )
                    if created:
                        root_metadata = WORKSPACE_DIR.stat()
                        os.fchown(
                            next_fd,
                            root_metadata.st_uid,
                            root_metadata.st_gid,
                        )
                        os.fchmod(next_fd, 0o700)
                    os.close(directory_fd)
                    directory_fd = next_fd
                try:
                    leaf_metadata = os.stat(
                        parts[-1],
                        dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(leaf_metadata.st_mode):
                    _remove_workspace_entry_no_follow(
                        directory_fd,
                        parts[-1],
                        deadline_monotonic=deadline_monotonic,
                    )
            finally:
                os.close(directory_fd)
    finally:
        os.close(workspace_fd)


def _prune_uncommitted_workspace_entries(
    remote_paths: set[str],
    deadline_monotonic: float | None = None,
) -> None:
    """Delete absent warm-state entries bottom-up without following links."""
    committed_paths: set[str] = set()
    committed_parents: set[str] = set()
    for relative in remote_paths:
        if (
            relative == "attachments"
            or relative.startswith("attachments/")
            or _should_skip_relative(relative)
        ):
            continue
        try:
            parts = _validate_workspace_relative(relative)
        except OSError:
            continue
        committed_paths.add(relative)
        committed_parents.update(
            "/".join(parts[:index])
            for index in range(1, len(parts))
        )

    visited = 0

    def prune_directory(directory_fd: int, parent_relative: str) -> None:
        nonlocal visited
        with os.scandir(directory_fd) as entries:
            names = [entry.name for entry in entries]
        for name in names:
            _remaining_timeout(deadline_monotonic, 60)
            visited += 1
            if visited > MAX_SYNC_ENTRIES:
                raise WorkspaceRestoreIncomplete(
                    "exact restore prune entry-count limit reached"
                )
            relative = (
                f"{parent_relative}/{name}" if parent_relative else name
            )
            if relative == "attachments":
                try:
                    attachment_metadata = os.stat(
                        name,
                        dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    continue
                if stat.S_ISDIR(attachment_metadata.st_mode):
                    continue
                os.unlink(name, dir_fd=directory_fd)
                continue
            if (
                relative.startswith("attachments/")
                or _preserve_image_owned_relative(relative)
            ):
                continue
            try:
                metadata = os.stat(
                    name,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(metadata.st_mode):
                child_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
                try:
                    prune_directory(child_fd, relative)
                finally:
                    os.close(child_fd)
                if relative not in committed_parents:
                    try:
                        os.rmdir(name, dir_fd=directory_fd)
                    except OSError as exc:
                        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                            raise
                continue
            if relative not in committed_paths:
                os.unlink(name, dir_fd=directory_fd)

    workspace_fd = os.open(
        WORKSPACE_DIR,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        prune_directory(workspace_fd, "")
    finally:
        os.close(workspace_fd)


def _iter_workspace_sqlite_sidecars(
    deadline_monotonic: float | None = None,
):
    """Yield transient SQLite sidecars without following model symlinks."""
    stack: list[str] = [""]
    visited = 0
    while stack:
        relative_directory = stack.pop()
        directory_fd = os.open(
            WORKSPACE_DIR / relative_directory,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        try:
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    _remaining_timeout(deadline_monotonic, 60)
                    visited += 1
                    if visited > MAX_SYNC_ENTRIES:
                        raise WorkspaceRestoreIncomplete(
                            "exact restore sidecar traversal limit reached"
                        )
                    relative = (
                        f"{relative_directory}/{entry.name}"
                        if relative_directory
                        else entry.name
                    )
                    if relative.startswith("attachments/"):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if len(Path(relative).parts) > MAX_SYNC_DEPTH:
                            raise WorkspaceRestoreIncomplete(
                                "exact restore sidecar depth limit reached"
                            )
                        stack.append(relative)
                    elif entry.is_file(follow_symlinks=False):
                        name = entry.name
                        is_sqlite_transient = (
                            name.endswith((
                                ".sqlite-wal",
                                ".sqlite-shm",
                                ".sqlite-journal",
                            ))
                            or name.endswith(".reindex-lock.sqlite")
                            or bool(
                                _matches_skip_basename_pattern(name)
                            )
                        )
                        if is_sqlite_transient:
                            yield relative
        finally:
            os.close(directory_fd)


def _discard_uncommitted_local_state(
    remote_paths: set[str],
    deadline_monotonic: float | None = None,
) -> None:
    """Remove sync-eligible local paths absent from the committed checkpoint."""
    _prepare_committed_remote_parents(remote_paths, deadline_monotonic)
    _prune_uncommitted_workspace_entries(remote_paths, deadline_monotonic)

    # pull_workspace deliberately never restores WAL/SHM/journal files beside
    # a main database. Remove stale local sidecars explicitly so a dirty warm
    # tree cannot replay uncommitted pages into the committed SQLite file.
    for relative in list(
        _iter_workspace_sqlite_sidecars(deadline_monotonic)
    ):
        name = Path(relative).name
        remove_transient = (
            name.endswith(".reindex-lock.sqlite")
            or _matches_skip_basename_pattern(name)
        )
        if not remove_transient:
            for suffix in ("-wal", "-shm", "-journal"):
                if relative.endswith(suffix):
                    remove_transient = _is_managed_openclaw_sqlite(
                        relative[: -len(suffix)]
                    )
                    break
        if remove_transient:
            _unlink_workspace_regular_no_follow(relative)


def _restore_missing_image_seeds(remote_paths: set[str]) -> None:
    for relative, content in _IMAGE_WORKSPACE_SEEDS.items():
        if relative not in remote_paths:
            _restore_image_seed(relative, content)


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
    retry_transient: bool = False,
    maximum_timeout_seconds: float = 20,
) -> dict:
    """Call the trusted storage broker with the opaque signed owner context."""
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    headers.update(_workspace_flush_headers())
    retry_delays = (
        _TRANSIENT_READ_RETRY_DELAYS_SECONDS
        if retry_transient
        else ()
    )
    for attempt in range(len(retry_delays) + 1):
        # A spent turn-wide budget is terminal. Calculate it outside the
        # network exception handler so the local deadline is never mistaken
        # for a transient socket timeout and retried after finalization has
        # already expired.
        request_timeout = _remaining_timeout(
            deadline_monotonic,
            maximum_timeout_seconds,
        )
        request = urllib.request.Request(
            "http://127.0.0.1:18791/agent-broker/api/agent/workspace-storage",
            data=body,
            method="POST",
            headers=headers,
        )
        retry_error: RuntimeError | None = None
        retry_cause: BaseException | None = None
        status: int | str = "network"
        try:
            with urllib.request.urlopen(
                request,
                timeout=request_timeout,
            ) as response:
                result = json.loads(response.read())
            if not isinstance(result, dict):
                raise RuntimeError("workspace broker returned invalid JSON")
            return result
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(500).decode("utf-8", errors="replace")
            finally:
                exc.close()
            try:
                error_body: object = json.loads(detail)
            except (TypeError, ValueError):
                error_body = None
            error = _WorkspaceBrokerHttpError(
                exc.code,
                detail,
                error_body,
                prior_transient_attempts=attempt,
            )
            if exc.code not in _TRANSIENT_HTTP_STATUSES:
                raise error from exc
            retry_error = error
            retry_cause = exc
            status = exc.code
        except (
            urllib.error.URLError,
            TimeoutError,
            ConnectionError,
            http.client.IncompleteRead,
            http.client.RemoteDisconnected,
        ) as exc:
            retry_error = RuntimeError(
                f"workspace broker network error: {exc}"
            )
            retry_cause = exc

        if retry_error is None or retry_cause is None:
            raise RuntimeError("workspace broker retry state is invalid")
        if attempt >= len(retry_delays):
            raise retry_error from retry_cause
        delay = retry_delays[attempt]
        logger.warning(
            "workspace broker read retry: operation=%s status=%s "
            "attempt=%d/%d delay_s=%.2f",
            payload.get("operation", "unknown"),
            status,
            attempt + 1,
            len(retry_delays) + 1,
            delay,
        )
        time.sleep(delay)
    raise RuntimeError("workspace broker retry loop exhausted")


def _workspace_flush_headers() -> dict[str, str]:
    """Return root-only workspace sync/final-flush authority."""
    if os.geteuid() != 0:
        return {}
    try:
        sync_token = Path(WORKSPACE_SYNC_TOKEN_PATH).read_text(
            encoding="ascii"
        ).strip()
    except FileNotFoundError:
        return {}
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", sync_token):
        raise RuntimeError("workspace sync authority is malformed")
    headers = {"X-Agent-Workspace-Sync": sync_token}
    try:
        token = Path(WORKSPACE_FLUSH_TOKEN_PATH).read_text(
            encoding="ascii"
        ).strip()
    except FileNotFoundError:
        return headers
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise RuntimeError("workspace flush authority is malformed")
    headers["X-Agent-Workspace-Flush"] = token
    return headers


def _download_spec(relative: str) -> tuple[str, int, dict[str, str]]:
    result = _broker_request(
        {"operation": "download", "path": relative},
        retry_transient=True,
    )
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
    expected_generation: str = "0" * 64,
    deadline_monotonic: float | None = None,
) -> _PreparedWorkspaceUpload | tuple[str, str, dict[str, str]]:
    result = _broker_request({
        "operation": "upload",
        "path": relative,
        "contentType": WORKSPACE_UPLOAD_CONTENT_TYPE,
        "contentLength": content_length,
        "idempotencyKey": idempotency_key,
        "checksumSha256": checksum_sha256,
        "workspaceGeneration": expected_generation,
    }, deadline_monotonic)
    url = result.get("uploadUrl")
    if (
        result.get("unchanged") is True
        and isinstance(result.get("key"), str)
    ):
        e_tag = result.get("eTag")
        if not isinstance(e_tag, str) or not e_tag:
            if expected_generation != "0" * 64:
                raise RuntimeError(
                    "workspace broker returned unchanged without generation metadata"
                )
            e_tag = '"legacy-unfenced-test"'
        return _PreparedWorkspaceUpload(
            upload_url=None,
            reservation_id=None,
            required_headers={},
            unchanged_e_tag=e_tag,
        )
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


def _complete_upload_reservation(
    reservation_id: str,
    generation: str,
    deadline_monotonic: float | None,
) -> tuple[str, str]:
    """Idempotently commit one staged object and return its new generation."""
    completed = _broker_request(
        {
            "operation": "complete-upload",
            "reservationId": reservation_id,
            "workspaceGeneration": generation,
        },
        deadline_monotonic,
        retry_transient=True,
        maximum_timeout_seconds=(
            WORKSPACE_MUTATION_BROKER_TIMEOUT_SECONDS
        ),
    )
    next_generation = completed.get("workspaceGeneration")
    e_tag = completed.get("eTag")
    if (
        not isinstance(completed.get("key"), str)
        or not isinstance(e_tag, str)
        or not e_tag
        or not isinstance(next_generation, str)
        or not re.fullmatch(r"[0-9a-f]{64}", next_generation)
    ):
        raise RuntimeError(
            "workspace broker did not verify generation-fenced upload"
        )
    return next_generation, e_tag


def _delete_workspace_path(
    relative: str,
    generation: str,
    deadline_monotonic: float | None,
) -> str:
    """Delete one absent mutable path with an idempotent generation fence."""
    result = _broker_request(
        {
            "operation": "delete",
            "path": relative,
            "workspaceGeneration": generation,
        },
        deadline_monotonic,
        retry_transient=True,
        maximum_timeout_seconds=(
            WORKSPACE_MUTATION_BROKER_TIMEOUT_SECONDS
        ),
    )
    next_generation = result.get("workspaceGeneration")
    if (
        not isinstance(result.get("deleted"), bool)
        or not isinstance(next_generation, str)
        or not re.fullmatch(r"[0-9a-f]{64}", next_generation)
    ):
        raise RuntimeError(
            "workspace broker did not verify generation-fenced deletion"
        )
    return next_generation


def _parse_checkpoint_snapshot(
    value: object,
    checkpoint_generation: str,
) -> _RemoteWorkspaceSnapshot:
    """Validate the broker's inline authoritative checkpoint snapshot."""
    if (
        not isinstance(value, dict)
        or set(value) != {"workspaceGeneration", "entries"}
    ):
        raise WorkspaceGenerationUnavailable(
            "workspace broker returned a malformed checkpoint snapshot"
        )
    snapshot_generation = value.get("workspaceGeneration")
    entries = value.get("entries")
    if (
        not isinstance(snapshot_generation, str)
        or not re.fullmatch(r"[0-9a-f]{64}", snapshot_generation)
        or not isinstance(entries, list)
    ):
        raise WorkspaceGenerationUnavailable(
            "workspace broker returned a malformed checkpoint snapshot"
        )
    if snapshot_generation != checkpoint_generation:
        raise WorkspaceGenerationConflict(
            "workspace checkpoint snapshot generation disagreed with checkpoint"
        )
    if len(entries) > MAX_SYNC_FILES:
        raise WorkspaceRestoreIncomplete(
            "restore incomplete (file-count backstop reached)"
        )

    paths: list[str] = []
    sizes: dict[str, int] = {}
    e_tags: dict[str, str] = {}
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "size", "eTag"}
        ):
            raise WorkspaceGenerationUnavailable(
                "workspace broker returned a malformed checkpoint snapshot entry"
            )
        relative = entry.get("path")
        size = entry.get("size")
        e_tag = entry.get("eTag")
        if (
            not isinstance(relative, str)
            or not relative
            or relative in sizes
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or size > MAX_SYNC_FILE_BYTES
            or not isinstance(e_tag, str)
            or not e_tag
            or len(e_tag) > 1_024
        ):
            raise WorkspaceGenerationUnavailable(
                "workspace broker returned a malformed checkpoint snapshot entry"
            )
        if not _is_checkpoint_managed_relative(relative):
            raise WorkspaceGenerationUnavailable(
                "workspace checkpoint snapshot included an unmanaged path"
            )
        rejection_reason = _workspace_relative_rejection_reason(relative)
        if rejection_reason is not None:
            path_hash = hashlib.sha256(
                relative.encode("utf-8", errors="surrogatepass")
            ).hexdigest()[:16]
            raise WorkspaceRestoreIncomplete(
                "restore incompatible workspace path "
                f"reason={rejection_reason} path_hash={path_hash}"
            )
        paths.append(relative)
        sizes[relative] = size
        e_tags[relative] = e_tag

    computed_generation = _generation_for_entries({
        relative: (sizes[relative], e_tags[relative])
        for relative in paths
    })
    if computed_generation != snapshot_generation:
        raise WorkspaceGenerationConflict(
            "workspace checkpoint snapshot did not form its claimed generation"
        )
    return _RemoteWorkspaceSnapshot(
        paths=tuple(paths),
        sizes=sizes,
        e_tags=e_tags,
        generation=snapshot_generation,
    )


def _is_valid_checkpoint_finalization_proof(value: object) -> bool:
    """Return whether an opaque proof can be transported losslessly as UTF-8."""
    if not isinstance(value, str) or not value:
        return False
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return False
    return len(encoded) <= MAX_WORKSPACE_FINALIZATION_PROOF_BYTES


def _ensure_workspace_checkpoint(
    prefix: str,
    deadline_monotonic: float | None = None,
) -> _EnsuredWorkspaceCheckpoint:
    """Recover or establish the broker's last complete workspace checkpoint."""
    result = _broker_request(
        {"operation": "ensure-checkpoint"},
        deadline_monotonic,
        maximum_timeout_seconds=(
            WORKSPACE_CHECKPOINT_BROKER_TIMEOUT_SECONDS
        ),
    )
    generation = result.get("workspaceGeneration")
    if (
        result.get("checkpointReady") is not True
        or not isinstance(generation, str)
        or not re.fullmatch(r"[0-9a-f]{64}", generation)
    ):
        raise WorkspaceGenerationUnavailable(
            "workspace broker did not establish a durable checkpoint"
        )
    has_atomic_version = "atomicCheckpointCommitVersion" in result
    has_finalization_proof = "checkpointFinalizationProof" in result
    atomic_version = result.get("atomicCheckpointCommitVersion")
    finalization_proof = result.get("checkpointFinalizationProof")
    if has_atomic_version != has_finalization_proof:
        raise WorkspaceGenerationUnavailable(
            "workspace broker returned an incomplete finalization capability"
        )
    if has_atomic_version and (
        atomic_version != 1
        or isinstance(atomic_version, bool)
        or not _is_valid_checkpoint_finalization_proof(
            finalization_proof
        )
    ):
        raise WorkspaceGenerationUnavailable(
            "workspace broker returned a malformed finalization capability"
        )
    snapshot = (
        _parse_checkpoint_snapshot(
            result["checkpointSnapshot"],
            generation,
        )
        if "checkpointSnapshot" in result
        else None
    )
    return _EnsuredWorkspaceCheckpoint(
        generation=generation,
        snapshot=snapshot,
        atomic_checkpoint_commit_version=(
            atomic_version if has_atomic_version else None
        ),
        checkpoint_finalization_proof=(
            finalization_proof if has_finalization_proof else None
        ),
    )


def _commit_workspace_checkpoint(
    prefix: str,
    base_generation: str,
    final_generation: str,
    deadline_monotonic: float | None = None,
) -> str:
    """Atomically publish the completed multi-file turn after all promotions."""
    result = _broker_request(
        {
            "operation": "commit-checkpoint",
            "baseWorkspaceGeneration": base_generation,
            "workspaceGeneration": final_generation,
        },
        deadline_monotonic,
        maximum_timeout_seconds=(
            WORKSPACE_CHECKPOINT_BROKER_TIMEOUT_SECONDS
        ),
    )
    committed_generation = result.get("workspaceGeneration")
    if (
        result.get("checkpointCommitted") is not True
        or committed_generation != final_generation
    ):
        raise WorkspacePushIncomplete(
            "workspace broker did not commit the complete checkpoint"
        )
    _committed_workspace_generations[prefix] = committed_generation
    return committed_generation


def _finalize_workspace_checkpoint(
    base_generation: str,
    proof: str,
    reservation_ids: tuple[str, ...],
    deleted_paths: tuple[str, ...],
    deadline_monotonic: float | None = None,
) -> _FinalizedWorkspaceCheckpoint:
    """Atomically promote every staged mutation and publish its checkpoint."""
    if (
        not re.fullmatch(r"[0-9a-f]{64}", base_generation)
        or not _is_valid_checkpoint_finalization_proof(proof)
        or len({value.lower() for value in reservation_ids}) != len(
            reservation_ids
        )
        or len(set(deleted_paths)) != len(deleted_paths)
        or (
            len(reservation_ids) + len(deleted_paths)
            > MAX_WORKSPACE_FINALIZATION_ITEMS
        )
        or any(
            re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-"
                r"[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                reservation_id,
                flags=re.IGNORECASE,
            ) is None
            for reservation_id in reservation_ids
        )
    ):
        raise WorkspacePushIncomplete(
            "workspace atomic finalization request is malformed"
        )
    result = _broker_request(
        {
            "operation": "finalize-checkpoint",
            "baseWorkspaceGeneration": base_generation,
            "checkpointFinalizationProof": proof,
            "reservationIds": list(reservation_ids),
            "deletedPaths": list(deleted_paths),
        },
        deadline_monotonic,
        retry_transient=True,
        maximum_timeout_seconds=(
            WORKSPACE_MUTATION_BROKER_TIMEOUT_SECONDS
        ),
    )
    if set(result) != {
        "checkpointCommitted",
        "workspaceGeneration",
        "uploads",
        "deletions",
    }:
        raise WorkspacePushIncomplete(
            "workspace broker returned a malformed atomic finalization"
        )
    generation = result.get("workspaceGeneration")
    raw_uploads = result.get("uploads")
    raw_deletions = result.get("deletions")
    if (
        result.get("checkpointCommitted") is not True
        or not isinstance(generation, str)
        or re.fullmatch(r"[0-9a-f]{64}", generation) is None
        or not isinstance(raw_uploads, list)
        or not isinstance(raw_deletions, list)
        or len(raw_uploads) != len(reservation_ids)
        or len(raw_deletions) != len(deleted_paths)
    ):
        raise WorkspacePushIncomplete(
            "workspace broker returned a malformed atomic finalization"
        )

    uploads: list[tuple[str, str, str]] = []
    for expected_reservation_id, entry in zip(
        reservation_ids,
        raw_uploads,
    ):
        if (
            not isinstance(entry, dict)
            or set(entry) != {"reservationId", "key", "eTag"}
            or entry.get("reservationId") != expected_reservation_id
            or not isinstance(entry.get("key"), str)
            or not entry["key"]
            or not isinstance(entry.get("eTag"), str)
            or not entry["eTag"]
            or len(entry["eTag"]) > 1_024
        ):
            raise WorkspacePushIncomplete(
                "workspace broker returned a malformed atomic upload result"
            )
        uploads.append(
            (entry["reservationId"], entry["key"], entry["eTag"])
        )

    deletions: list[tuple[str, bool]] = []
    for expected_path, entry in zip(deleted_paths, raw_deletions):
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "deleted"}
            or entry.get("path") != expected_path
            or not isinstance(entry.get("deleted"), bool)
        ):
            raise WorkspacePushIncomplete(
                "workspace broker returned a malformed atomic deletion result"
            )
        deletions.append((entry["path"], entry["deleted"]))

    return _FinalizedWorkspaceCheckpoint(
        generation=generation,
        uploads=tuple(uploads),
        deletions=tuple(deletions),
    )


def _is_side_effect_free_finalize_rejection(error: BaseException) -> bool:
    """Return whether the first wire attempt was rejected before dispatch.

    A later old-task 400 cannot erase ambiguity from an earlier timeout or
    transient response that may have followed a successful new-task commit.
    """
    return (
        isinstance(error, _WorkspaceBrokerHttpError)
        and error.status == 400
        and error.prior_transient_attempts == 0
        and error.error_body == {"error": "Invalid storage request"}
    )


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


def _generation_for_entries(
    entries: dict[str, tuple[int, str]],
) -> str:
    """Hash one complete S3 listing with an unambiguous cross-language format."""
    digest = hashlib.sha256()
    for relative in sorted(entries):
        if not _is_checkpoint_managed_relative(relative):
            # Router inputs, deployed config, telemetry, transient databases,
            # and regenerable dependency trees are not mutable user history.
            # Keep the exact exclusion set aligned with the web checkpoint via
            # workspace_policy.json so neither side hashes a different state.
            continue
        _validate_workspace_relative(relative)
        size, e_tag = entries[relative]
        path_bytes = relative.encode("utf-8")
        e_tag_bytes = e_tag.encode("utf-8")
        digest.update(struct.pack(">Q", len(path_bytes)))
        digest.update(path_bytes)
        digest.update(struct.pack(">Q", size))
        digest.update(struct.pack(">Q", len(e_tag_bytes)))
        digest.update(e_tag_bytes)
    return digest.hexdigest()


def _list_remote_workspace_snapshot(
    prefix: str,
    deadline_monotonic: float | None = None,
) -> _RemoteWorkspaceSnapshot:
    """Read every broker page and return a trusted generation when possible.

    Older broker deployments did not return ETags. Their listings remain
    usable for a conservative full restore, but can never prove that a warm
    microVM is current or authorize a final push.
    """
    listed_paths: list[str] = []
    seen_paths: set[str] = set()
    listed_sizes: dict[str, int] = {}
    listed_e_tags: dict[str, str] = {}
    metadata_trusted = True
    continuation: str | None = None
    seen_continuations: set[str] = set()

    while True:
        request_payload = {"operation": "list"}
        if continuation:
            request_payload["continuationToken"] = continuation
        page = _broker_request(
            request_payload,
            deadline_monotonic=deadline_monotonic,
            retry_transient=True,
        )
        paths = page.get("paths")
        if not isinstance(paths, list):
            raise RuntimeError("workspace broker returned invalid path list")
        page_paths: list[str] = []
        for relative in paths:
            if not isinstance(relative, str) or not relative:
                raise RuntimeError("workspace broker returned invalid path")
            if _is_checkpoint_managed_relative(relative):
                rejection_reason = _workspace_relative_rejection_reason(
                    relative
                )
                if rejection_reason is not None:
                    path_hash = hashlib.sha256(
                        relative.encode("utf-8", errors="surrogatepass")
                    ).hexdigest()[:16]
                    raise WorkspaceRestoreIncomplete(
                        "restore incompatible workspace path "
                        f"reason={rejection_reason} path_hash={path_hash}"
                    )
            if relative in seen_paths:
                raise RuntimeError("workspace broker returned duplicate path")
            if len(listed_paths) >= MAX_SYNC_FILES:
                raise WorkspaceRestoreIncomplete(
                    "restore incomplete (file-count backstop reached) "
                    f"for prefix {prefix}"
                )
            listed_paths.append(relative)
            seen_paths.add(relative)
            page_paths.append(relative)

        entries = page.get("entries")
        page_metadata: dict[str, tuple[int, str]] = {}
        page_sizes: dict[str, int] = {}
        if not isinstance(entries, list):
            metadata_trusted = False
        else:
            for entry in entries:
                if not isinstance(entry, dict):
                    metadata_trusted = False
                    continue
                entry_path = entry.get("path")
                entry_size = entry.get("size")
                last_modified = entry.get("lastModified")
                e_tag = entry.get("eTag")
                size_valid = (
                    isinstance(entry_path, str)
                    and entry_path in page_paths
                    and isinstance(entry_size, int)
                    and not isinstance(entry_size, bool)
                    and 0 <= entry_size <= MAX_SYNC_FILE_BYTES
                    and entry_path not in page_sizes
                )
                if size_valid:
                    page_sizes[entry_path] = entry_size
                valid = (
                    size_valid
                    and isinstance(last_modified, int)
                    and not isinstance(last_modified, bool)
                    and last_modified >= 0
                    and isinstance(e_tag, str)
                    and 0 < len(e_tag) <= 1_024
                    and entry_path not in page_metadata
                )
                if not valid:
                    metadata_trusted = False
                    continue
                page_metadata[entry_path] = (entry_size, e_tag)
            if set(page_metadata) != set(page_paths):
                metadata_trusted = False

        listed_sizes.update(page_sizes)
        for relative, (size, e_tag) in page_metadata.items():
            listed_sizes[relative] = size
            listed_e_tags[relative] = e_tag

        raw_continuation = page.get("continuationToken")
        if raw_continuation is None or raw_continuation == "":
            break
        if not isinstance(raw_continuation, str):
            raise RuntimeError(
                "workspace broker returned invalid continuation token"
            )
        if raw_continuation in seen_continuations:
            raise RuntimeError(
                "workspace broker repeated a continuation token"
            )
        seen_continuations.add(raw_continuation)
        continuation = raw_continuation

    generation: str | None = None
    if metadata_trusted and len(listed_e_tags) == len(listed_paths):
        generation = _generation_for_entries(
            {
                relative: (listed_sizes[relative], listed_e_tags[relative])
                for relative in listed_paths
            }
        )
    return _RemoteWorkspaceSnapshot(
        paths=tuple(listed_paths),
        sizes=listed_sizes,
        e_tags=listed_e_tags,
        generation=generation,
    )


def workspace_generation(prefix: str) -> str | None:
    """Return the last fully restored/committed generation for this prefix."""
    pending = _pending_workspace_generations.get(prefix)
    if pending is not None:
        return pending
    snapshot = _remote_workspace_snapshots.get(prefix)
    return snapshot.generation if snapshot is not None else None


def pull_workspace(
    prefix: str,
    _snapshot: _RemoteWorkspaceSnapshot | None = None,
) -> int:
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

    # Collect the complete listing before choosing downloads. The durable
    # migration marker sorts after agents/* in S3, so deciding page-by-page can
    # mistakenly trim the very JSONL history a first-time migration needs.
    snapshot = _snapshot or _list_remote_workspace_snapshot(prefix)
    listed_paths = list(snapshot.paths)
    for relative in listed_paths:
        if not _is_checkpoint_managed_relative(relative):
            continue
        rejection_reason = _workspace_relative_rejection_reason(relative)
        if rejection_reason is not None:
            path_hash = hashlib.sha256(
                relative.encode("utf-8", errors="surrogatepass")
            ).hexdigest()[:16]
            raise WorkspaceRestoreIncomplete(
                "restore incompatible workspace path "
                f"reason={rejection_reason} path_hash={path_hash}"
            )

    # No local tree mutation is permitted until the entire authoritative path
    # set has passed the same contract as the web checkpoint.
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    listed_sizes = snapshot.sizes
    skipped = 0
    exact_restore_paths = set(listed_paths)
    if prefix in _force_exact_workspace_restores:
        # Prune before any marker/object download so an uncommitted local
        # file/symlink cannot block a committed remote descendant.
        _discard_uncommitted_local_state(exact_restore_paths)

    from concurrent.futures import ThreadPoolExecutor

    total_bytes = 0
    total_lock = threading.Lock()

    def _download_one(
        item: tuple[str, Optional[int]],
    ) -> tuple[Optional[str], Optional[tuple[int, int, int]]]:
        nonlocal total_bytes
        relative, declared_size = item
        try:
            if declared_size == 0:
                _materialize_empty_workspace_file(relative)
            else:
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
                        return (
                            f"{relative}: aggregate byte backstop",
                            None,
                        )
                    total_bytes += content_length
                _download_workspace_file(
                    url,
                    relative,
                    content_length,
                    required_headers,
                )
            try:
                restored, metadata = _open_regular_no_follow(relative)
                restored.close()
                return None, (
                    metadata.st_size,
                    metadata.st_mtime_ns,
                    metadata.st_ctime_ns,
                )
            except OSError as exc:
                # The restore itself completed. Omitting the cache entry is
                # conservative: push_workspace will inspect or upload the path
                # again instead of trusting an unverified signature.
                logger.warning(
                    "workspace restored signature unavailable for %s: %s",
                    relative,
                    exc,
                )
            return None, None
        except Exception as exc:  # noqa: BLE001
            return f"{relative}: {exc}", None

    # The marker controls whether hundreds of megabytes of legacy transcripts
    # may be omitted. Restore and validate its exact bytes before making that
    # decision: path presence alone is not a trustworthy migration boundary.
    marker_restored = False
    marker_signature: Optional[tuple[int, int, int]] = None
    migration_complete = False
    if OPENCLAW_MIGRATION_MARKER in listed_paths:
        marker_error, marker_signature = _download_one(
            (
                OPENCLAW_MIGRATION_MARKER,
                listed_sizes.get(OPENCLAW_MIGRATION_MARKER),
            )
        )
        if marker_error is not None:
            raise WorkspaceRestoreIncomplete(
                "restore incomplete (migration marker download failed: "
                f"{marker_error}) for prefix {prefix}"
            )
        marker_restored = True
        migration_complete = openclaw_migration_complete()
        if not migration_complete:
            logger.warning(
                "workspace migration marker is invalid; restoring legacy archive"
            )

    to_download: list[tuple[str, Optional[int]]] = []
    for relative in listed_paths:
        if relative == OPENCLAW_MIGRATION_MARKER and marker_restored:
            continue
        if migration_complete and _is_imported_legacy_state(relative):
            skipped += 1
            continue
        if _should_skip_relative(relative):
            # Gateway-owned config, telemetry, or SQLite transient state.
            # Never let S3 override the image config or pair a main database
            # with a WAL/SHM file from another point in time.
            skipped += 1
            continue
        # The complete authoritative set was validated before any local
        # mutation. Keep this assertion beside the install boundary too.
        _validate_workspace_relative(relative)
        to_download.append((relative, listed_sizes.get(relative)))

    restored_signatures: dict[str, tuple[int, int, int]] = {}
    if marker_restored and marker_signature is not None:
        restored_signatures[OPENCLAW_MIGRATION_MARKER] = marker_signature
    count = 1 if marker_restored else 0
    download_errors: list[str] = []
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
        for item, result in zip(
            to_download,
            pool.map(_download_one, to_download),
        ):
            err, signature = result
            if err is None:
                count += 1
                if signature is not None:
                    restored_signatures[item[0]] = signature
            else:
                logger.warning("workspace pull skip %s", err)
                download_errors.append(err)
    elapsed = time.monotonic() - started

    if download_errors:
        # A partial local tree must never become a new remote generation. The
        # caller suppresses every push and retries on the next invocation.
        reason = f"{len(download_errors)} object download(s) failed"
        raise WorkspaceRestoreIncomplete(
            f"restore incomplete ({reason}) for prefix {prefix}"
        )

    if prefix in _force_exact_workspace_restores:
        _restore_missing_image_seeds(exact_restore_paths)

    # A successful pull is an exact remote snapshot. Seed the push cache only
    # after every required object has restored so an unchanged turn does not
    # re-hash/re-negotiate the entire workspace before replying. Never publish
    # partial-restore signatures: doing so could hide missing local state.
    for state_key in [
        key for key in _uploaded_state if key[0] == prefix
    ]:
        _uploaded_state.pop(state_key, None)
    _uploaded_state.update(
        {
            (prefix, relative): signature
            for relative, signature in restored_signatures.items()
        }
    )
    if snapshot.generation is None:
        _remote_workspace_snapshots.pop(prefix, None)
    else:
        _remote_workspace_snapshots[prefix] = snapshot
    _pending_workspace_generations.pop(prefix, None)
    _pending_workspace_completions.pop(prefix, None)
    _pending_atomic_workspace_finalizations.pop(prefix, None)
    _force_exact_workspace_restores.discard(prefix)

    logger.info(
        "workspace pull: prefix=%s files=%d skipped=%d migrated=%s "
        "generation=%s elapsed_s=%.1f",
        prefix,
        count,
        skipped,
        migration_complete,
        snapshot.generation[:12] if snapshot.generation else "untrusted",
        elapsed,
    )
    return count


def refresh_workspace(prefix: str) -> int:
    """Refresh a warm workspace after the owner-wide lock changes hands."""
    if not prefix:
        return 0
    # The gateway is stopped before refresh. Remove retired OpenClaw host
    # control files even when the durable generation is unchanged; otherwise
    # its migration gate can keep a reused microVM permanently bricked.
    _discard_retired_local_control_state()
    checkpoint = _ensure_workspace_checkpoint(prefix)
    if (
        checkpoint.atomic_checkpoint_commit_version == 1
        and checkpoint.checkpoint_finalization_proof is not None
    ):
        _atomic_checkpoint_finalization_capabilities[prefix] = (
            _AtomicCheckpointFinalizationCapability(
                version=1,
                proof=checkpoint.checkpoint_finalization_proof,
            )
        )
    else:
        _atomic_checkpoint_finalization_capabilities.pop(prefix, None)
    snapshot = checkpoint.snapshot
    if snapshot is None:
        # Rolling compatibility: an older broker does not include the
        # authoritative snapshot captured while establishing the checkpoint.
        snapshot = _list_remote_workspace_snapshot(prefix)
    if snapshot.generation is None:
        raise WorkspaceGenerationUnavailable(
            "workspace broker metadata is incomplete after checkpoint recovery"
        )
    if snapshot.generation != checkpoint.generation:
        raise WorkspaceGenerationConflict(
            "workspace broker did not restore the committed checkpoint"
        )
    cached = _remote_workspace_snapshots.get(prefix)
    if (
        cached is not None
        and cached.generation == snapshot.generation
    ):
        _committed_workspace_generations[prefix] = checkpoint.generation
        logger.info(
            "workspace refresh: prefix=%s generation=%s unchanged",
            prefix,
            snapshot.generation[:12],
        )
        return 0
    # Every non-cached restore must be exact. A different cached generation
    # means another serialized runtime committed a new snapshot; no cache at
    # all can also mean the wrapper/module restarted while the microVM
    # filesystem survived. In either case, overlaying would retain paths that
    # were deleted remotely and the next push would resurrect them. The
    # gateway is stopped before refresh, so prune every sync-eligible local
    # path absent from the committed generation before downloading it.
    _force_exact_workspace_restores.add(prefix)
    logger.info(
        "workspace refresh: prefix=%s generation=%s action=restore",
        prefix,
        snapshot.generation[:12] if snapshot.generation else "untrusted",
    )
    pulled = pull_workspace(prefix, snapshot)
    _committed_workspace_generations[prefix] = checkpoint.generation
    return pulled


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


def _is_managed_openclaw_sqlite(relative: str) -> bool:
    """Return whether a SQLite path is durable OpenClaw/Codex state."""
    if relative in {
        "state/openclaw.sqlite",
        "tasks/runs.sqlite",
        "flows/registry.sqlite",
        "memory/main.sqlite",
    }:
        return True
    parts = Path(relative).parts
    return (
        len(parts) >= 4
        and parts[0] == "agents"
        and parts[2] == "agent"
        and relative.endswith(".sqlite")
    )


# ── OpenClaw transcript-database pruning ──────────────────────────────────────
#
# `agents/<id>/agent/openclaw-agent.sqlite` is OpenClaw's own database and it
# grows monotonically: nothing in OpenClaw, and nothing here, ever removed a
# row. On 2026-09-05 one owner's file reached 268,390,400 bytes — 45,056 bytes
# under the broker's then-256 MiB upload cap — and the workspace could never be
# saved again. Every turn and all three of that owner's 15-minute schedules
# failed at finalization, and two more owners were within 30 % of the same wall.
#
# Profiling that real database: `trajectory_runtime_events` held 128.1 MB of the
# 268 MB in only 3,468 rows (~37 KB of `event_json` each) — 48 % of the file.
# `transcript_events`, the table the product actually reads back, was 20.3 MB.
# VACUUM alone reclaimed nothing (23 free pages). Deleting the runtime-event
# rows of CLOSED sessions and vacuuming took the same file to 153,149,440 bytes
# with `integrity_check` ok, `foreign_key_check` clean and WAL mode intact.
#
# So: prune ONLY `trajectory_runtime_events`, ONLY for sessions with no activity
# in the retention window, and only once the file is actually large.
# `transcript_events`, `session_windows`, `memory_index_chunks` and
# `memory_embedding_cache` are never touched — they are durable history and
# recall, not per-turn runtime tracing.
def _positive_int_env(name: str, default: int) -> int:
    """Read a positive integer override, falling back on anything malformed."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


TRANSCRIPT_DB_FILENAME = "openclaw-agent.sqlite"
TRAJECTORY_EVENTS_TABLE = "trajectory_runtime_events"
# Prune only once the file is big enough to be worth the VACUUM. Comfortably
# under the old 256 MiB cliff, so a workspace approaching trouble is trimmed
# well before it can reach the current 512 MiB ceiling.
TRAJECTORY_PRUNE_MIN_DB_BYTES = _positive_int_env(
    "OPENCLAW_TRAJECTORY_PRUNE_MIN_DB_BYTES", 192 * 1024 * 1024
)
# Keep every session that did anything inside this window, including the one
# this very turn belongs to. Two days was the value validated against the real
# database above.
TRAJECTORY_PRUNE_KEEP_DAYS = _positive_int_env(
    "OPENCLAW_TRAJECTORY_PRUNE_KEEP_DAYS", 2
)
# Pruning is an optimization on the finalization path, which is already inside a
# hard flush deadline. Bound it so a pathological VACUUM cannot eat the budget
# that the actual upload needs. This is enforced with a progress handler, NOT
# with sqlite3.connect(timeout=...) — that argument only bounds how long a
# statement waits to acquire a lock, never how long one runs.
TRAJECTORY_PRUNE_TIMEOUT_SECONDS = 60
# Only rewrite the whole file when there is real space to win. VACUUM copies the
# database, so running it to reclaim a few pages costs far more (time, and
# transient disk equal to the file's own size) than it returns.
TRAJECTORY_VACUUM_MIN_FREE_BYTES = 16 * 1024 * 1024
# Candidate activity columns, most authoritative first. The column set is
# DISCOVERED rather than assumed: an OpenClaw upgrade that renames or drops one
# must make this skip, never make it delete the wrong rows.
_TRAJECTORY_SESSION_COLUMNS = ("session_id", "sessionId")
_TRAJECTORY_TIME_COLUMNS = ("created_at", "createdAt", "timestamp", "ts")


def _first_present(candidates: tuple, available: set) -> str | None:
    for name in candidates:
        if name in available:
            return name
    return None


def _trajectory_cutoff_value(newest: object, keep_days: int) -> int | None:
    """Convert the table's own newest timestamp into a cutoff in its own units.

    The column is an integer epoch, but OpenClaw has shipped both seconds and
    milliseconds. Rather than guess from a constant, derive the unit from the
    magnitude of the newest value the table actually holds, and refuse to prune
    anything that is not a plain positive integer.
    """
    if isinstance(newest, bool) or not isinstance(newest, int) or newest <= 0:
        return None
    if newest >= 10**12:
        window = keep_days * 86_400_000
    elif newest >= 10**9:
        window = keep_days * 86_400
    else:
        # Neither a seconds nor a milliseconds epoch. Unknown unit: do nothing.
        return None
    return newest - window


def _prune_trajectory_runtime_events(
    database: Path,
    keep_days: int = TRAJECTORY_PRUNE_KEEP_DAYS,
    deadline_monotonic: float | None = None,
) -> int:
    """Delete closed sessions' runtime-event rows, then VACUUM. Best-effort.

    Returns the number of rows deleted (0 when nothing was eligible or the
    schema did not match what this function knows how to prune safely).

    The gateway MUST already be stopped — this runs from
    prepare_sqlite_snapshot(), after adapter.shutdown().
    """
    with closing(
        sqlite3.connect(
            f"{database.as_uri()}?mode=rw",
            uri=True,
            timeout=TRAJECTORY_PRUNE_TIMEOUT_SECONDS,
        )
    ) as connection:
        table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (TRAJECTORY_EVENTS_TABLE,),
        ).fetchone()
        if table is None:
            return 0
        columns = {
            str(row[1])
            for row in connection.execute(
                f'PRAGMA table_info("{TRAJECTORY_EVENTS_TABLE}")'
            ).fetchall()
        }
        session_column = _first_present(_TRAJECTORY_SESSION_COLUMNS, columns)
        time_column = _first_present(_TRAJECTORY_TIME_COLUMNS, columns)
        if session_column is None or time_column is None:
            logger.info(
                "trajectory prune skipped — %s lacks a session/time column",
                TRAJECTORY_EVENTS_TABLE,
            )
            return 0

        # Identifiers are interpolated; every one of them came from
        # sqlite_master/table_info and was matched against a fixed tuple of
        # literals above, so no caller-controlled text reaches the SQL text.
        newest = connection.execute(
            f'SELECT MAX("{time_column}") FROM "{TRAJECTORY_EVENTS_TABLE}"'
        ).fetchone()[0]
        cutoff = _trajectory_cutoff_value(newest, keep_days)
        if cutoff is None:
            logger.info(
                "trajectory prune skipped — %s.%s is not an epoch integer",
                TRAJECTORY_EVENTS_TABLE,
                time_column,
            )
            return 0

        # Foreign keys ON so a row some other table depends on aborts the prune
        # rather than silently orphaning a reference.
        connection.execute("PRAGMA foreign_keys=ON")
        # Delete by SESSION, not by row age: a long-running session's early
        # events stay with its recent ones, and any session that did anything
        # inside the window is kept whole.
        cursor = connection.execute(
            f'DELETE FROM "{TRAJECTORY_EVENTS_TABLE}" '
            f'WHERE "{session_column}" IN ('
            f'  SELECT "{session_column}" FROM "{TRAJECTORY_EVENTS_TABLE}"'
            f'  GROUP BY "{session_column}"'
            f'  HAVING MAX("{time_column}") < ?'
            f")",
            (cutoff,),
        )
        deleted = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
        # Check BEFORE committing. Run after commit this proves nothing: the
        # rows are already durably gone, so raising can only stop the VACUUM,
        # not undo the damage it is supposed to be protecting against.
        violations = connection.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            connection.rollback()
            raise RuntimeError(
                f"trajectory prune would leave {len(violations)} "
                "foreign-key violation(s); rolled back"
            )
        connection.commit()

        # VACUUM on its own schedule, NOT gated on `deleted`. The delete is
        # already committed by this point, so a VACUUM that fails once (disk
        # pressure, a lock, an exhausted deadline) must not strand the file
        # forever: on the next turn the same rows are already gone, `deleted`
        # comes back 0, and an early return here would skip the VACUUM for
        # good — leaving the bloated file that this whole function exists to
        # shrink. Freelist pages are the real signal that bytes are reclaimable.
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        free_pages = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
        if free_pages * page_size < TRAJECTORY_VACUUM_MIN_FREE_BYTES:
            return deleted

        # Bound the VACUUM for real. `sqlite3.connect(timeout=...)` is the
        # BUSY-handler timeout — how long a statement waits to ACQUIRE a lock —
        # and places no cap whatever on how long VACUUM runs once it starts.
        # The progress handler is the only in-process way to abort a running
        # statement, so the deadline is enforced there.
        vacuum_deadline = time.monotonic() + _remaining_timeout(
            deadline_monotonic, TRAJECTORY_PRUNE_TIMEOUT_SECONDS
        )

        def _abort_when_out_of_time() -> int:
            # Non-zero aborts the running statement with sqlite3.OperationalError.
            return 1 if time.monotonic() > vacuum_deadline else 0

        connection.isolation_level = None
        connection.set_progress_handler(_abort_when_out_of_time, 10_000)
        try:
            connection.execute("VACUUM")
        except sqlite3.OperationalError as exc:
            # Out of budget, or the file could not be rewritten. The delete
            # stands and is durable; the file simply keeps its freelist until
            # a later turn reaches this point with more time. Deliberately not
            # fatal — the caller still has an upload to get through.
            connection.set_progress_handler(None, 0)
            logger.warning(
                "trajectory prune deleted %d row(s) but could not VACUUM %s: %s",
                deleted,
                database.name,
                exc,
            )
            return deleted
        finally:
            connection.set_progress_handler(None, 0)
        mode = connection.execute("PRAGMA journal_mode").fetchone()
        if mode is None or str(mode[0]).lower() != "wal":
            raise RuntimeError(
                "trajectory prune did not preserve WAL journal mode"
            )
    return deleted


def _prune_oversized_transcript_databases(
    deadline_monotonic: float | None = None,
) -> None:
    """Trim any agent transcript database that has grown large. Never raises."""
    workspace_root = WORKSPACE_DIR.resolve()
    for relative in _iter_workspace_files():
        # Match the SAME predicate prepare_sqlite_snapshot() uses, not just the
        # basename. A basename match would open and rewrite any file called
        # openclaw-agent.sqlite anywhere in the tree — including under
        # attachments/, which _iter_workspace_files does traverse — rather than
        # only the managed agents/<id>/agent/ database this knows how to prune.
        if not _is_managed_openclaw_sqlite(relative):
            continue
        database = WORKSPACE_DIR / relative
        try:
            # Re-resolve and re-anchor before opening rw, the same way
            # prepare_sqlite_snapshot does for this file class.
            database.resolve().relative_to(workspace_root)
            size_before = database.stat().st_size
        except (OSError, ValueError):
            continue
        if size_before < TRAJECTORY_PRUNE_MIN_DB_BYTES:
            continue
        try:
            deleted = _prune_trajectory_runtime_events(
                database, deadline_monotonic=deadline_monotonic
            )
        except Exception as exc:  # noqa: BLE001
            # A prune failure must never block the save it exists to protect.
            # The checkpoint + integrity_check below still gate the push.
            logger.warning(
                "trajectory prune failed for %s: %s", relative, exc
            )
            continue
        try:
            size_after = database.stat().st_size
        except OSError:
            size_after = size_before
        # Reported even when deleted == 0: a run that deletes nothing can still
        # have reclaimed a previous run's freelist, and "0 rows but 40 MB
        # smaller" is exactly the recovery-after-a-failed-VACUUM case that is
        # worth being able to see in the logs.
        logger.info(
            "trajectory prune %s: rows=%d bytes %d -> %d",
            relative,
            deleted,
            size_before,
            size_after,
        )


def prepare_sqlite_snapshot(deadline_monotonic: float | None = None) -> int:
    """Checkpoint and validate every persisted OpenClaw database.

    The gateway MUST be stopped before this runs. A failed checkpoint or
    integrity check aborts the subsequent push, preserving the last known-good
    remote database rather than replacing it with a torn generation.

    Oversized transcript databases are pruned FIRST, so the checkpoint and
    integrity check below validate the file that is actually about to be
    uploaded rather than the pre-prune one.

    `deadline_monotonic` MUST be the same deadline the following push is held
    to. The prune runs before the upload but inside the one flush budget, so
    passing None here lets a slow VACUUM spend time the push then no longer
    has — the caller computes the deadline first and threads it through.
    """
    _prune_oversized_transcript_databases(deadline_monotonic)
    candidates = sorted(
        WORKSPACE_DIR / relative
        for relative in _iter_workspace_files()
        if _is_managed_openclaw_sqlite(relative)
    )
    checked = 0
    workspace_root = WORKSPACE_DIR.resolve()
    for database in candidates:
        resolved = database.resolve()
        try:
            resolved.relative_to(workspace_root)
        except ValueError as exc:
            raise RuntimeError("SQLite database escaped workspace root") from exc
        if resolved != database.absolute():
            raise RuntimeError("SQLite database path contains a symlink")
        database_uri = f"{database.as_uri()}?mode=rw"
        with closing(
            sqlite3.connect(database_uri, uri=True, timeout=30)
        ) as connection:
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

    pulled = 0
    total_bytes = 0
    for rel in relative_paths:
        if pulled >= MAX_SYNC_FILES:
            logger.warning("pull_files: file-count limit reached")
            break
        if not isinstance(rel, str) or not rel:
            continue
        try:
            _validate_workspace_relative(rel)
        except OSError:
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
                rel,
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
            raise WorkspacePushIncomplete(
                "workspace traversal could not open directory "
                f"{relative_directory or '.'}: {exc}"
            ) from exc
        try:
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    _remaining_timeout(deadline_monotonic, 60)
                    visited += 1
                    if visited > MAX_SYNC_ENTRIES:
                        raise WorkspacePushIncomplete(
                            "workspace traversal entry-count limit reached"
                        )
                    relative = (
                        f"{relative_directory}/{entry.name}"
                        if relative_directory
                        else entry.name
                    )
                    if _should_skip_relative(relative):
                        continue
                    rejection_reason = _workspace_relative_rejection_reason(
                        relative
                    )
                    if rejection_reason is not None:
                        path_hash = hashlib.sha256(
                            relative.encode(
                                "utf-8",
                                errors="surrogatepass",
                            )
                        ).hexdigest()[:16]
                        raise WorkspacePushIncomplete(
                            "workspace traversal found an incompatible path "
                            f"reason={rejection_reason} "
                            f"path_hash={path_hash}"
                        )
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if len(Path(relative).parts) <= MAX_SYNC_DEPTH:
                                stack.append(relative)
                            else:
                                raise WorkspacePushIncomplete(
                                    "workspace traversal directory depth limit "
                                    f"reached at {relative}"
                                )
                        elif entry.is_file(follow_symlinks=False):
                            yield relative
                        else:
                            logger.warning(
                                "workspace push skip unsafe entry %s",
                                relative,
                            )
                    except OSError as exc:
                        raise WorkspacePushIncomplete(
                            "workspace traversal could not inspect entry "
                            f"{relative}: {exc}"
                        ) from exc
        finally:
            os.close(directory_fd)


def _remote_mutable_paths_to_delete(
    remote_paths: tuple[str, ...],
    local_mutable_paths: set[str],
    migration_complete: bool,
) -> list[str]:
    """Return only absent mutable paths; archives and router state survive."""
    return sorted(
        relative
        for relative in remote_paths
        if (
            relative not in local_mutable_paths
            and relative != "attachments"
            and not relative.startswith("attachments/")
            and not _should_skip_relative(relative)
            and not (
                migration_complete
                and _is_imported_legacy_state(relative)
            )
        )
    )


def _apply_atomic_workspace_finalization(
    prefix: str,
    pending: _PendingAtomicWorkspaceFinalization,
    finalized: _FinalizedWorkspaceCheckpoint,
) -> str:
    """Validate the batch generation before publishing any local cache state."""
    final_entries = {
        relative: (size, e_tag)
        for relative, size, e_tag in pending.base_entries
    }
    for relative in pending.deleted_paths:
        final_entries.pop(relative, None)
    for (
        relative,
        content_length,
        _modified_ns,
        _changed_ns,
        e_tag,
    ) in pending.unchanged_uploads:
        final_entries[relative] = (content_length, e_tag)
    if len(finalized.uploads) != len(pending.uploads):
        raise WorkspacePushIncomplete(
            "workspace atomic finalization omitted an upload"
        )
    for completion, upload in zip(pending.uploads, finalized.uploads):
        reservation_id, key, e_tag = upload
        if (
            reservation_id != completion.reservation_id
            or key != f"{prefix}/{completion.relative}"
        ):
            raise WorkspacePushIncomplete(
                "workspace atomic finalization returned mismatched upload metadata"
            )
        final_entries[completion.relative] = (
            completion.content_length,
            e_tag,
        )

    synthesized_generation = _generation_for_entries(final_entries)
    if synthesized_generation != finalized.generation:
        raise WorkspaceGenerationConflict(
            "workspace atomic mutation results did not form the broker generation"
        )

    # Publish caches only after the complete response and local generation have
    # been verified. A malformed/lost response leaves the exact batch pending.
    for relative in pending.deleted_paths:
        _uploaded_state.pop((prefix, relative), None)
    for completion in pending.uploads:
        _uploaded_state[(prefix, completion.relative)] = (
            completion.content_length,
            completion.modified_ns,
            completion.changed_ns,
        )
    for (
        relative,
        content_length,
        modified_ns,
        changed_ns,
        _e_tag,
    ) in pending.unchanged_uploads:
        _uploaded_state[(prefix, relative)] = (
            content_length,
            modified_ns,
            changed_ns,
        )

    committed = _RemoteWorkspaceSnapshot(
        paths=tuple(sorted(final_entries)),
        sizes={
            relative: metadata[0]
            for relative, metadata in final_entries.items()
        },
        e_tags={
            relative: metadata[1]
            for relative, metadata in final_entries.items()
        },
        generation=finalized.generation,
    )
    _remote_workspace_snapshots[prefix] = committed
    _committed_workspace_generations[prefix] = finalized.generation
    _atomic_checkpoint_finalization_capabilities.pop(prefix, None)
    _pending_workspace_generations.pop(prefix, None)
    _pending_workspace_completions.pop(prefix, None)
    _pending_atomic_workspace_finalizations.pop(prefix, None)
    return finalized.generation


def _legacy_finalize_pending_atomic_workspace(
    prefix: str,
    pending: _PendingAtomicWorkspaceFinalization,
    deadline_monotonic: float | None,
) -> str:
    """Finish a parse-time-rejected batch through the old fenced protocol."""
    _atomic_checkpoint_finalization_capabilities.pop(prefix, None)
    _pending_atomic_workspace_finalizations.pop(prefix, None)
    current_generation = pending.base_generation
    final_entries = {
        relative: (size, e_tag)
        for relative, size, e_tag in pending.base_entries
    }
    for relative in pending.deleted_paths:
        current_generation = _delete_workspace_path(
            relative,
            current_generation,
            deadline_monotonic,
        )
        final_entries.pop(relative, None)
        _uploaded_state.pop((prefix, relative), None)
        _pending_workspace_generations[prefix] = current_generation

    for completion in pending.uploads:
        _pending_workspace_completions[prefix] = completion
        current_generation, e_tag = _complete_upload_reservation(
            completion.reservation_id,
            current_generation,
            deadline_monotonic,
        )
        _pending_workspace_completions.pop(prefix, None)
        _uploaded_state[(prefix, completion.relative)] = (
            completion.content_length,
            completion.modified_ns,
            completion.changed_ns,
        )
        final_entries[completion.relative] = (
            completion.content_length,
            e_tag,
        )
        _pending_workspace_generations[prefix] = current_generation

    for (
        relative,
        content_length,
        modified_ns,
        changed_ns,
        e_tag,
    ) in pending.unchanged_uploads:
        _uploaded_state[(prefix, relative)] = (
            content_length,
            modified_ns,
            changed_ns,
        )
        final_entries[relative] = (content_length, e_tag)

    synthesized_generation = _generation_for_entries(final_entries)
    if synthesized_generation != current_generation:
        raise WorkspaceGenerationConflict(
            "workspace mutation results did not form the broker generation"
        )
    _commit_workspace_checkpoint(
        prefix,
        pending.base_generation,
        current_generation,
        deadline_monotonic,
    )
    _remote_workspace_snapshots[prefix] = _RemoteWorkspaceSnapshot(
        paths=tuple(sorted(final_entries)),
        sizes={
            relative: metadata[0]
            for relative, metadata in final_entries.items()
        },
        e_tags={
            relative: metadata[1]
            for relative, metadata in final_entries.items()
        },
        generation=current_generation,
    )
    _pending_workspace_generations.pop(prefix, None)
    _pending_workspace_completions.pop(prefix, None)
    return current_generation


# One release call carries at most this many ids, matching the broker's
# MAX_RELEASE_UPLOAD_ITEMS. A larger batch is chunked rather than rejected.
RELEASE_RESERVATION_BATCH = 250


def _release_staged_reservations(
    staged: list,
    deadline_monotonic: float | None = None,
) -> None:
    """Abandon the reservations of a finalization batch that will not commit.

    A workspace push is atomic: every changed file is reserved and staged, then
    the whole set is committed together. When one file is refused the batch is
    dead — but its SIBLINGS' rows stay `reserved` for the full five-minute
    lease, and the broker's partial unique index
    `uq_workspace_upload_target_active (owner_key, target_key)` then rejects the
    retry's reservation for those very same paths. The natural recovery — run
    the turn again — therefore failed in ~30 ms with an opaque `Failed query`
    until the TTL ran out (prod 2026-09-05).

    Best-effort by contract. The reservations expire on their own regardless, so
    a failure here must never replace the real, actionable push error with a
    cleanup error.
    """
    reservation_ids = [
        prepared.reservation_id
        for _pair, prepared in staged
        if getattr(prepared, "reservation_id", None)
        and prepared.unchanged_e_tag is None
    ]
    if not reservation_ids:
        return
    for start in range(0, len(reservation_ids), RELEASE_RESERVATION_BATCH):
        chunk = reservation_ids[start:start + RELEASE_RESERVATION_BATCH]
        try:
            _broker_request(
                {"operation": "release-upload", "reservationIds": chunk},
                deadline_monotonic,
            )
        except Exception as exc:  # noqa: BLE001
            # Stop after the first failing chunk rather than hammering a broker
            # that is already refusing, and rather than spending a finalization
            # deadline that the real error still has to be reported within.
            # A 400 here specifically means the web tier predates `release-upload`
            # (same two-unit deploy-order note as BROKER_PRIVATE_UPLOAD_MAX_BYTES):
            # harmless, but until it catches up the siblings hold their rows for
            # the full lease, which is the behaviour this call exists to shorten.
            # Anything unreleased simply expires on its own five-minute lease,
            # which is the pre-existing behaviour this is an improvement on.
            logger.warning(
                "workspace push could not release %d staged reservation(s); "
                "abandoning the rest to their lease: %s",
                len(chunk),
                exc,
            )
            return
    logger.info(
        "workspace push released %d staged reservation(s) after abort",
        len(reservation_ids),
    )


def push_workspace(
    prefix: str,
    deadline_monotonic: float | None = None,
    expected_generation: str | None = None,
    require_generation: bool = False,
) -> int:
    """Upload current /home/node/.openclaw/ contents to s3://bucket/prefix/."""
    if not prefix:
        return 0
    # Parallelized for the same reason as pull: 10k+ files over a serial
    # upload blocks both the turn-final push and the best-effort shutdown
    # flush. Completed-turn durability comes from the normal pre-response
    # checkpoint commit; AgentCore can terminate an active shutdown attempt.
    to_upload: list[tuple[str, str, int, int, int, str]] = []
    marker_upload: Optional[
        tuple[str, str, int, int, int, str]
    ] = None
    preparation_errors: list[str] = []
    local_mutable_paths: set[str] = set()
    to_delete: list[str] = []
    total_bytes = 0
    migration_complete = openclaw_migration_complete()
    for relative in _iter_workspace_files(deadline_monotonic):
        if relative == "attachments" or relative.startswith("attachments/"):
            # Router-owned immutable input objects are already durable and may
            # be created while another thread waits for the workspace lock.
            # Never re-upload them as part of the mutable history transaction.
            continue
        if migration_complete and _is_imported_legacy_state(relative):
            # The verified marker means these sources are already represented
            # in SQLite and their originals remain preserved in versioned S3.
            # OpenClaw's generated *.imported-* copies add no durable history.
            continue
        local_mutable_paths.add(relative)
        path = WORKSPACE_DIR / relative
        try:
            source, metadata = _open_regular_no_follow(relative)
        except OSError as exc:
            logger.warning("workspace push skip unsafe file %s: %s", relative, exc)
            preparation_errors.append(f"{relative}: {exc}")
            continue
        if metadata.st_size > BROKER_PRIVATE_UPLOAD_MAX_BYTES:
            source.close()
            # Named and sized deliberately: this error text is what reaches the
            # user, and "retry later" is wrong advice for a file that will be
            # exactly as large next turn.
            logger.warning(
                "workspace push skip file over broker cap %s (%d bytes)",
                relative,
                metadata.st_size,
            )
            preparation_errors.append(
                f"{relative}: {metadata.st_size} bytes exceeds the "
                f"{BROKER_PRIVATE_UPLOAD_MAX_BYTES}-byte workspace upload limit"
            )
            continue
        if metadata.st_size > MAX_SYNC_FILE_BYTES:
            source.close()
            logger.warning("workspace push skip oversized file %s", relative)
            preparation_errors.append(f"{relative}: oversized file")
            continue
        signature = (
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )
        state_key = (prefix, relative)
        if _uploaded_state.get(state_key) == signature:
            source.close()
            continue
        queued_files = len(to_upload) + int(marker_upload is not None)
        if queued_files >= MAX_SYNC_FILES:
            source.close()
            logger.warning("workspace push file-count limit reached")
            preparation_errors.append("file-count limit reached")
            break
        if total_bytes + metadata.st_size > MAX_SYNC_TOTAL_BYTES:
            source.close()
            logger.warning("workspace push aggregate byte limit reached")
            preparation_errors.append("aggregate byte limit reached")
            break
        total_bytes += metadata.st_size
        digest = hashlib.sha256()
        marker_bytes = (
            bytearray() if relative == OPENCLAW_MIGRATION_MARKER else None
        )
        with source:
            while True:
                _remaining_timeout(deadline_monotonic, 60)
                chunk = source.read(TRANSFER_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                if marker_bytes is not None:
                    marker_bytes.extend(chunk)
        upload = (
            str(path),
            relative,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
            base64.b64encode(digest.digest()).decode("ascii"),
        )
        if relative == OPENCLAW_MIGRATION_MARKER:
            if bytes(marker_bytes or b"") != _OPENCLAW_MIGRATION_MARKER_BYTES:
                logger.warning(
                    "workspace push ignored invalid migration marker"
                )
                continue
            marker_upload = upload
        else:
            to_upload.append(upload)

    if preparation_errors:
        # Carry the per-file detail, not just a count. The count alone is what
        # produced the unactionable "retry after the agent service is repaired"
        # message an owner saw for a day while one over-cap file blocked every
        # save (prod 2026-09-05).
        raise WorkspacePushIncomplete(
            f"workspace push incomplete ({len(preparation_errors)} file "
            f"error(s)) for prefix {prefix}: "
            + "; ".join(preparation_errors[:5])
        )

    current_generation = expected_generation
    if current_generation is None and not require_generation:
        # Test/backward-compatibility path only. Production finalization always
        # supplies the trusted hydrated generation and sets require_generation.
        # A current broker rejects this sentinel rather than accepting an
        # unfenced legacy write.
        current_generation = "0" * 64
    if require_generation:
        if (
            not isinstance(current_generation, str)
            or not re.fullmatch(r"[0-9a-f]{64}", current_generation)
        ):
            raise WorkspaceGenerationUnavailable(
                "workspace generation is unavailable; refusing final push"
            )
        continuing_pending_push = (
            prefix in _pending_workspace_generations
            or prefix in _pending_workspace_completions
            or prefix in _pending_atomic_workspace_finalizations
        )
        base_checkpoint_generation = _committed_workspace_generations.get(
            prefix
        )
        if (
            not isinstance(base_checkpoint_generation, str)
            or not re.fullmatch(
                r"[0-9a-f]{64}",
                base_checkpoint_generation,
            )
        ):
            raise WorkspaceGenerationUnavailable(
                "committed workspace checkpoint is unavailable"
            )
        pending_atomic = _pending_atomic_workspace_finalizations.get(prefix)
        if pending_atomic is not None:
            if (
                current_generation != pending_atomic.base_generation
                or base_checkpoint_generation
                != pending_atomic.base_generation
            ):
                raise WorkspaceGenerationConflict(
                    "pending atomic finalization lost its base generation"
                )
            current_pairs = list(to_upload)
            if marker_upload is not None:
                current_pairs.append(marker_upload)
            current_signatures = {
                pair[1]: (pair[2], pair[3], pair[4])
                for pair in current_pairs
            }
            pending_signatures = {
                completion.relative: (
                    completion.content_length,
                    completion.modified_ns,
                    completion.changed_ns,
                )
                for completion in pending_atomic.uploads
            }
            pending_signatures.update({
                relative: (content_length, modified_ns, changed_ns)
                for (
                    relative,
                    content_length,
                    modified_ns,
                    changed_ns,
                    _e_tag,
                ) in pending_atomic.unchanged_uploads
            })
            if (
                current_signatures != pending_signatures
                or any(
                    relative in local_mutable_paths
                    for relative in pending_atomic.deleted_paths
                )
            ):
                raise WorkspaceGenerationConflict(
                    "local workspace changed while atomic finalization was pending"
                )
            # A retained batch has already crossed an ambiguous attempt
            # boundary. Even an exact old-route 400 on this later invocation
            # cannot prove the original attempt was side-effect-free, so only
            # an idempotent atomic replay may resolve it.
            finalized = _finalize_workspace_checkpoint(
                pending_atomic.base_generation,
                pending_atomic.proof,
                tuple(
                    completion.reservation_id
                    for completion in pending_atomic.uploads
                ),
                pending_atomic.deleted_paths,
                deadline_monotonic,
            )
            current_generation = _apply_atomic_workspace_finalization(
                prefix,
                pending_atomic,
                finalized,
            )
            logger.info(
                "workspace push resumed: prefix=%s generation=%s",
                prefix,
                current_generation[:12],
            )
            return 0
        if (
            not continuing_pending_push
            and base_checkpoint_generation != current_generation
        ):
            raise WorkspaceGenerationConflict(
                "hydrated workspace generation disagreed with checkpoint"
            )
        pending_completion = _pending_workspace_completions.get(prefix)
        if pending_completion is not None:
            current_generation, _e_tag = _complete_upload_reservation(
                pending_completion.reservation_id,
                current_generation,
                deadline_monotonic,
            )
            _uploaded_state[
                (prefix, pending_completion.relative)
            ] = (
                pending_completion.content_length,
                pending_completion.modified_ns,
                pending_completion.changed_ns,
            )
            to_upload = [
                pair
                for pair in to_upload
                if not (
                    pair[1] == pending_completion.relative
                    and pair[2] == pending_completion.content_length
                    and pair[3] == pending_completion.modified_ns
                    and pair[4] == pending_completion.changed_ns
                )
            ]
            if (
                marker_upload is not None
                and marker_upload[1] == pending_completion.relative
                and marker_upload[2] == pending_completion.content_length
                and marker_upload[3] == pending_completion.modified_ns
                and marker_upload[4] == pending_completion.changed_ns
            ):
                marker_upload = None
            _pending_workspace_generations[prefix] = current_generation
            _pending_workspace_completions.pop(prefix, None)
        # The successful restore/refresh retained the complete checkpoint
        # snapshot while the owner-wide lease was held. A resumed partial push
        # no longer has that exact base, so it deliberately re-lists before
        # replaying its pending completion.
        cached_before_upload = _remote_workspace_snapshots.get(prefix)
        if (
            not continuing_pending_push
            and cached_before_upload is not None
            and cached_before_upload.generation == current_generation
        ):
            before_upload = cached_before_upload
        else:
            before_upload = _list_remote_workspace_snapshot(
                prefix,
                deadline_monotonic,
            )
        if before_upload.generation is None:
            raise WorkspaceGenerationUnavailable(
                "workspace broker metadata is incomplete; refusing final push"
            )
        if before_upload.generation != current_generation:
            raise WorkspaceGenerationConflict(
                "authoritative workspace changed before final push"
            )
        to_delete = _remote_mutable_paths_to_delete(
            before_upload.paths,
            local_mutable_paths,
            migration_complete,
        )
        _pending_workspace_generations[prefix] = current_generation

    from concurrent.futures import ThreadPoolExecutor

    def _stage_one(
        pair: tuple[str, str, int, int, int, str],
    ) -> tuple[
        tuple[str, str, int, int, int, str],
        _PreparedWorkspaceUpload | None,
        Optional[str],
    ]:
        (
            path,
            relative,
            content_length,
            modified_ns,
            changed_ns,
            checksum_sha256,
        ) = pair
        try:
            if current_generation is None:
                raise WorkspaceGenerationUnavailable(
                    "workspace generation is required for private upload"
                )
            prepared = _upload_spec(
                relative,
                content_length,
                str(uuid.uuid4()),
                checksum_sha256,
                current_generation,
                deadline_monotonic,
            )
            if prepared is None:
                prepared = _PreparedWorkspaceUpload(
                    upload_url=None,
                    reservation_id=None,
                    required_headers={},
                    unchanged_e_tag='"legacy-unfenced-test"',
                )
            elif isinstance(prepared, tuple):
                upload_url, reservation_id, required_headers = prepared
                prepared = _PreparedWorkspaceUpload(
                    upload_url=upload_url,
                    reservation_id=reservation_id,
                    required_headers=required_headers,
                )
            if prepared.unchanged_e_tag is not None:
                return pair, prepared, None
            if prepared.upload_url is None or prepared.reservation_id is None:
                raise RuntimeError(
                    "workspace broker returned incomplete upload reservation"
                )
            _stream_upload(
                prepared.upload_url,
                relative,
                content_length,
                prepared.required_headers,
                deadline_monotonic,
            )
            return pair, prepared, None
        except Exception as exc:  # noqa: BLE001
            return pair, None, f"{path}: {exc}"

    def _complete_one(
        pair: tuple[str, str, int, int, int, str],
        prepared: _PreparedWorkspaceUpload,
        generation: str,
    ) -> tuple[str, str | None]:
        (
            _path,
            relative,
            content_length,
            modified_ns,
            changed_ns,
            _checksum,
        ) = pair
        if prepared.unchanged_e_tag is not None:
            _uploaded_state[(prefix, relative)] = (
                content_length,
                modified_ns,
                changed_ns,
            )
            return generation, prepared.unchanged_e_tag
        if prepared.reservation_id is None:
            raise RuntimeError(
                "workspace upload reservation id is unavailable"
            )
        if require_generation:
            _pending_workspace_completions[prefix] = (
                _PendingWorkspaceCompletion(
                    reservation_id=prepared.reservation_id,
                    relative=relative,
                    content_length=content_length,
                    modified_ns=modified_ns,
                    changed_ns=changed_ns,
                )
            )
            next_generation, e_tag = _complete_upload_reservation(
                prepared.reservation_id,
                generation,
                deadline_monotonic,
            )
            _pending_workspace_completions.pop(prefix, None)
            _uploaded_state[(prefix, relative)] = (
                content_length,
                modified_ns,
                changed_ns,
            )
            return next_generation, e_tag
        completed = _broker_request(
            {
                "operation": "complete-upload",
                "reservationId": prepared.reservation_id,
                "workspaceGeneration": generation,
            },
            deadline_monotonic,
        )
        next_generation = completed.get("workspaceGeneration")
        if isinstance(completed.get("key"), str):
            _uploaded_state[(prefix, relative)] = (
                content_length,
                modified_ns,
                changed_ns,
            )
            e_tag = completed.get("eTag")
            return generation, e_tag if isinstance(e_tag, str) else None
        if (
            not isinstance(completed.get("key"), str)
            or not isinstance(completed.get("eTag"), str)
            or not completed.get("eTag")
            or not isinstance(next_generation, str)
            or not re.fullmatch(r"[0-9a-f]{64}", next_generation)
        ):
            raise RuntimeError(
                "workspace broker did not verify generation-fenced upload"
            )
        _uploaded_state[(prefix, relative)] = (
            content_length,
            modified_ns,
            changed_ns,
        )
        return next_generation, completed["eTag"]

    count = 0
    started = time.monotonic()
    staged: list[
            tuple[
            tuple[str, str, int, int, int, str],
            _PreparedWorkspaceUpload,
        ]
    ] = []
    stage_errors: list[str] = []
    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as pool:
        for pair, prepared, error in pool.map(_stage_one, to_upload):
            if error is None and prepared is not None:
                staged.append((pair, prepared))
            else:
                assert error is not None
                logger.warning("workspace push stage skip %s", error)
                stage_errors.append(error)
    if stage_errors:
        _release_staged_reservations(staged, deadline_monotonic)
        raise WorkspacePushIncomplete(
            f"workspace push incomplete ({len(stage_errors)} file error(s)) "
            f"for prefix {prefix}: " + "; ".join(stage_errors[:5])
        )
    # Stage the migration marker last. Atomic-capable brokers promote this
    # reservation in the same checkpoint as every database/state object; the
    # legacy path below still completes it after the earlier staged entries.
    if marker_upload is not None:
        marker_pair, marker_prepared, marker_error = _stage_one(
            marker_upload
        )
        if marker_error is not None or marker_prepared is None:
            _release_staged_reservations(staged, deadline_monotonic)
            raise WorkspacePushIncomplete(
                "workspace push incomplete (migration marker stage failed) "
                f"for prefix {prefix}: {marker_error or 'unknown error'}"
            )
        staged.append((marker_pair, marker_prepared))

    try:
        assert current_generation is not None
        final_entries = (
            {
                relative: (
                    before_upload.sizes[relative],
                    before_upload.e_tags[relative],
                )
                for relative in before_upload.paths
            }
            if require_generation
            else {}
        )
        capability = _atomic_checkpoint_finalization_capabilities.get(prefix)
        if require_generation and capability is not None:
            pending_uploads: list[_PendingWorkspaceCompletion] = []
            unchanged_uploads: list[
                tuple[str, int, int, int, str]
            ] = []
            for pair, prepared in staged:
                if prepared.unchanged_e_tag is not None:
                    unchanged_uploads.append((
                        pair[1],
                        pair[2],
                        pair[3],
                        pair[4],
                        prepared.unchanged_e_tag,
                    ))
                    continue
                if prepared.reservation_id is None:
                    raise WorkspacePushIncomplete(
                        "workspace atomic upload reservation is unavailable"
                    )
                pending_uploads.append(_PendingWorkspaceCompletion(
                    reservation_id=prepared.reservation_id,
                    relative=pair[1],
                    content_length=pair[2],
                    modified_ns=pair[3],
                    changed_ns=pair[4],
                ))
            pending_atomic = _PendingAtomicWorkspaceFinalization(
                base_generation=base_checkpoint_generation,
                proof=capability.proof,
                uploads=tuple(pending_uploads),
                unchanged_uploads=tuple(unchanged_uploads),
                deleted_paths=tuple(to_delete),
                base_entries=tuple(
                    (
                        relative,
                        before_upload.sizes[relative],
                        before_upload.e_tags[relative],
                    )
                    for relative in before_upload.paths
                ),
            )
            _pending_atomic_workspace_finalizations[prefix] = pending_atomic
            atomic_committed = True
            try:
                finalized = _finalize_workspace_checkpoint(
                    pending_atomic.base_generation,
                    pending_atomic.proof,
                    tuple(
                        completion.reservation_id
                        for completion in pending_atomic.uploads
                    ),
                    pending_atomic.deleted_paths,
                    deadline_monotonic,
                )
                current_generation = _apply_atomic_workspace_finalization(
                    prefix,
                    pending_atomic,
                    finalized,
                )
            except Exception as exc:
                if not _is_side_effect_free_finalize_rejection(exc):
                    raise
                atomic_committed = False
                current_generation = (
                    _legacy_finalize_pending_atomic_workspace(
                        prefix,
                        pending_atomic,
                        deadline_monotonic,
                    )
                )
            count = len(to_delete) + len(staged)
            elapsed = time.monotonic() - started
            logger.info(
                "workspace push: prefix=%s files=%d generation=%s "
                "elapsed_s=%.1f atomic=%s",
                prefix,
                count,
                current_generation[:12],
                elapsed,
                atomic_committed,
            )
            return count
        for relative in to_delete:
            current_generation = _delete_workspace_path(
                relative,
                current_generation,
                deadline_monotonic,
            )
            final_entries.pop(relative, None)
            _uploaded_state.pop((prefix, relative), None)
            if require_generation:
                _pending_workspace_generations[prefix] = (
                    current_generation
                )
            count += 1
        for pair, prepared in staged:
            current_generation, e_tag = _complete_one(
                pair,
                prepared,
                current_generation,
            )
            if require_generation and e_tag is None:
                raise WorkspaceGenerationUnavailable(
                    "workspace upload completion returned no generation metadata"
                )
            if e_tag is not None:
                final_entries[pair[1]] = (pair[2], e_tag)
            if require_generation:
                _pending_workspace_generations[prefix] = current_generation
            count += 1

        if require_generation:
            synthesized_generation = _generation_for_entries(final_entries)
            if synthesized_generation != current_generation:
                raise WorkspaceGenerationConflict(
                    "workspace mutation results did not form the broker generation"
                )
            # This call performs the authoritative full snapshot read under
            # the broker lock and refuses the commit unless it exactly equals
            # current_generation. A separate client-side full listing right
            # before it was the same check twice and consumed another large
            # fraction of the turn-final deadline.
            _commit_workspace_checkpoint(
                prefix,
                base_checkpoint_generation,
                current_generation,
                deadline_monotonic,
            )
            committed = _RemoteWorkspaceSnapshot(
                paths=tuple(sorted(final_entries)),
                sizes={
                    relative: metadata[0]
                    for relative, metadata in final_entries.items()
                },
                e_tags={
                    relative: metadata[1]
                    for relative, metadata in final_entries.items()
                },
                generation=current_generation,
            )
            _remote_workspace_snapshots[prefix] = committed
            _pending_workspace_generations.pop(prefix, None)
            _pending_workspace_completions.pop(prefix, None)
    except Exception:
        raise

    elapsed = time.monotonic() - started

    logger.info(
        "workspace push: prefix=%s files=%d generation=%s elapsed_s=%.1f",
        prefix,
        count,
        current_generation[:12] if current_generation else "untrusted",
        elapsed,
    )
    return count
