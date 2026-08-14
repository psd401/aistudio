"""
Harness Adapter Interface — Abstraction layer for agent harnesses.

The adapter pattern allows swapping OpenClaw for Hermes (or any other harness)
without changing the AgentCore wrapper. Each adapter implements the same interface.
"""

import abc
import dataclasses
import json
import logging
import os
import pathlib
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import (
    Any, Callable, Dict, Iterable, List, Optional, Tuple, Union,
)

from agent_failures import emit_agent_metric, record_failure
from chat_format import markdown_to_chat

logger = logging.getLogger("harness_adapter")

PROCESS_GROUP_QUIESCE_SECONDS = 2.0
PROCESS_GROUP_POLL_SECONDS = 0.05


def _process_group_has_live_members(group_id: int) -> bool:
    """Return whether Linux reports a non-zombie member of one process group."""
    try:
        entries = os.scandir("/proc")
    except OSError:
        # Non-Linux fallback. Production AgentCore runtimes always provide
        # /proc; killpg(0) is conservative where zombie state is unavailable.
        try:
            os.killpg(group_id, 0)
            return True
        except ProcessLookupError:
            return False
    with entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                with open(
                    f"/proc/{entry.name}/stat",
                    encoding="utf-8",
                ) as process_stat:
                    value = process_stat.read(4096)
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
            closing_parenthesis = value.rfind(")")
            if closing_parenthesis < 0:
                continue
            fields = value[closing_parenthesis + 2:].split()
            if len(fields) < 3:
                continue
            state = fields[0]
            try:
                process_group = int(fields[2])
            except ValueError:
                continue
            if process_group == group_id and state != "Z":
                return True
    return False


def _wait_for_process_group_quiescence(
    group_id: int,
    timeout_seconds: float = PROCESS_GROUP_QUIESCE_SECONDS,
) -> None:
    """Prove no process can still mutate the workspace after group SIGKILL."""
    deadline = time.monotonic() + timeout_seconds
    while _process_group_has_live_members(group_id):
        if time.monotonic() >= deadline:
            raise RuntimeError(
                "OpenClaw process group did not become quiescent"
            )
        time.sleep(PROCESS_GROUP_POLL_SECONDS)


# Session/agent ids from the gateway event stream are interpolated into a
# transcript path, so they must be filename-safe before they touch the FS.
_SAFE_PATH_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
TERMINAL_USAGE_STOP_REASONS = frozenset({"stop", "end_turn"})


class TranscriptTableMissing(Exception):
    """The transcript database exists but predates the `transcript_events` table.

    Distinguished from a locked/busy database because the remedies are opposite:
    a lock clears on retry, a missing table never will. This one means the host
    is older than 2026.7.2-beta.5, so the per-session JSONL transcripts are still
    the real source and the reader must fall back to them rather than settle
    through six retries and report zeros — the exact silent-zero failure this
    module exists to prevent.
    """


def _is_safe_path_component(value: str) -> bool:
    """True when `value` is safe to interpolate as a single path segment.

    The charset check alone is not enough. `.` is a legal id character, so
    ".." passes the regex while still walking a directory upward once joined —
    the one traversal a `/`-free component can still perform. Excluding the
    dot-only names closes that without banning dots from ids generally.
    """
    return bool(_SAFE_PATH_ID.match(value or "")) and value not in {".", ".."}


def _catalog_tool_names(catalog: object) -> List[str]:
    """Return explicit catalog-entry names without traversing their schemas."""

    names: List[str] = []
    seen: set[str] = set()

    entries: List[object] = []
    if isinstance(catalog, (list, tuple)):
        entries.extend(catalog)
    elif isinstance(catalog, dict):
        if isinstance(catalog.get("name"), str):
            entries.append(catalog)
        else:
            for group in catalog.values():
                if isinstance(group, (list, tuple)):
                    entries.extend(group)
                elif isinstance(group, dict):
                    group_tools = group.get("tools")
                    if isinstance(group_tools, (list, tuple)):
                        entries.extend(group_tools)
                    elif isinstance(group.get("name"), str):
                        entries.append(group)

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if isinstance(name, str) and name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


@dataclasses.dataclass
class TurnResult:
    """Structured result of a single agent turn.

    Replaces the old `process() -> str` contract so the wrapper can pass
    real model / token / latency / tool metadata down to the router
    Lambda, which writes:
      - agent_messages (model, input_tokens, output_tokens, latency_ms)
      - agent_message_content (per-turn role/content rows)
      - agent_tool_invocations (per-turn tool calls with args + result)

    `text` is the user-visible reply (already passed through
    chat_format markdown→Chat-subset). Empty zero/None values are
    acceptable when the harness doesn't surface the data — the writer
    coalesces gracefully.
    """

    text: str
    model: Optional[str] = None
    tokens_in: int = 0
    tokens_out: int = 0
    # Bedrock prompt-caching split (issue #1089). Sourced from the OpenClaw
    # session transcript alongside tokens_in/tokens_out — see
    # OpenClawAdapter._read_turn_usage. Zero when the model doesn't cache or
    # the transcript read failed; usage_capture_complete distinguishes those
    # cases so downstream cost logic never prices a failed capture.
    cache_read: int = 0
    cache_write: int = 0
    usage_capture_complete: bool = False
    latency_ms: int = 0
    messages: List[Dict[str, Any]] = dataclasses.field(default_factory=list)
    tool_calls: List[Dict[str, Any]] = dataclasses.field(default_factory=list)
    # Tools that STARTED and never reported a terminal result — i.e. what was
    # still in `tool_starts` when the turn ended. A started-but-unfinished call
    # never lands in `tool_calls`, so without this an interrupted side effect
    # (the request reached the broker and created the Doc, its result event
    # simply never arrived) looks identical to a turn that ran nothing. It is
    # the most dangerous case, not the safest: `_should_retry_upstream` treats
    # a nonzero value as replay-UNSAFE, and `_frame_failed_partial` already
    # tells the user the same thing in prose.
    tools_in_flight: int = 0
    # Set True when this turn is an error/degraded return (session conflict,
    # deadline, empty response, WS failure) rather than a real answer. The
    # wrapper forwards this to the router (metadata.failed) so a 0-token error
    # turn is no longer logged as a clean "Message processed" success.
    failed: bool = False
    error_class: Optional[str] = None
    # Iteration telemetry (issue #1161): True when the empty-turn nudge fired
    # at least once this turn (the turn did tool work but produced no user-
    # visible text, so the harness sent one follow-up asking for the summary).
    # The wrapper forwards this as metadata.nudged -> agent_messages.nudged so
    # the dashboard can trend nudge-fire rate. A recovered-after-nudge turn
    # writes no agent_failures row, so this flag is its only persisted signal.
    nudged: bool = False


def _format_for_chat(text: str) -> str:
    """Final transform applied to every outbound message before it leaves
    the adapter. Converts model-emitted Markdown into Google Chat's
    rendering subset so the user sees clean output instead of literal
    `**bold**` / `## headers` / `[label](url)` syntax.

    Wrapped to swallow transformer errors — a malformed input must not
    block the reply. If the transform raises, return the original text
    so the user gets *something*.
    """
    if not text:
        return text
    try:
        return markdown_to_chat(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("chat_format transform failed: %s", str(exc)[:200])
        return text


CONTEXT_OVERFLOW_ERROR_CLASS = "ContextOverflow"
INCOMPLETE_TOOL_TURN_ERROR_CLASS = "OpenClawIncompleteToolTurn"

# Upstream-failure retry (2026-08-06 Bedrock 5xx incident). One retry only:
# the point is to absorb a transient fault, not to hammer a provider that is
# already unwell. The latency bound keeps the retry to turns that failed at
# the model call — the incident's turns died in ~6s — rather than something
# that collapsed late in real work.
UPSTREAM_RETRY_DELAY_S = 2.0
UPSTREAM_RETRY_MAX_LATENCY_MS = 30_000
# The retry runs inside the ORIGINAL turn's budget, not on a fresh one: the
# 550s interactive deadline exists to reserve the rest of the Router Lambda's
# 15-minute ceiling for workspace flushing and delivery, and a second full
# deadline would blow straight through it. The second attempt therefore gets
# only what is left after the first attempt and the backoff. Below this floor
# there is not enough turn left to be worth the attempt — and it is also
# `_resolve_deadline_s`'s own lower clamp, so a smaller remainder would be
# silently rounded back UP into an overshoot.
UPSTREAM_RETRY_MIN_REMAINING_S = 60


def _classify_chat_error(error_message: str) -> str:
    """Name the chat-error class from OpenClaw's message.

    Every chat-channel error arrives as the same generic OpenClawChatError, with
    the only distinguishing detail buried in free text. That conflates two very
    different situations:

      • Context overflow — the transcript outgrew the model's window. The work
        itself is fine; the SESSION is the problem, and continuing it is
        guaranteed to fail again. Recoverable, but only by starting fresh.
      • Incomplete post-tool turn — OpenClaw exhausted or declined its own
        tools-disabled finalization after possible effects. Retrying the
        original request is unsafe, but the distinct class and structured
        context make the exact failed pipeline boundary observable.
      • Everything else — a genuine fault. Retrying is not obviously safe.

    Downstream (agent-cron promotion, agent_failures, alarms) has to tell these
    apart, and the classification belongs HERE, where the message is produced,
    rather than as a regex duplicated into TypeScript. On 2026-07-27 the prod
    Morning Dispatch hit overflow twice, burned ~7 minutes retrying, and its
    failure was indistinguishable from a crash.

    Matches on the stable part of OpenClaw's wording ("context overflow" /
    "prompt too large"); an unrecognized message keeps the generic class, so a
    wording change degrades to today's behaviour rather than misclassifying.
    """
    lowered = (error_message or "").lower()
    if "context overflow" in lowered or "prompt too large" in lowered:
        return CONTEXT_OVERFLOW_ERROR_CLASS
    if (
        (
            "couldn't generate a response" in lowered
            or "could not generate a response" in lowered
        )
        and "some tool actions may have already been executed" in lowered
    ):
        return INCOMPLETE_TOOL_TURN_ERROR_CLASS
    return "OpenClawChatError"


def _frame_failed_partial(
    partial: str,
    completed_tools: Optional[List[Dict[str, Any]]] = None,
    in_flight_tools: Optional[Dict[str, Any]] = None,
) -> str:
    """Wrap a failed/degraded turn so it is never presented as a clean answer.

    When a turn dies mid-task the model has usually emitted some scratchpad
    narration ("Now let's read the file...") before it stopped. Posting that
    verbatim reads to the user as a finished reply, hiding the failure and any
    side effects that already ran (issue #1138 F4). Prefix an explicit error
    frame; keep the partial so the user still sees what completed. When there
    is no partial, return a standalone error.

    `partial` must already be chat-formatted (the frame text is plain).

    `completed_tools` names the tool calls that finished before the turn died.
    "Some steps may have already run" is unactionable on its own — a principal
    told that has no way to know whether a doc was created, an event booked, or
    nothing at all happened. We KNOW which tools completed, so say so.
    """
    partial = (partial or "").strip()
    ran = _describe_completed_tools(completed_tools, in_flight_tools)
    if partial:
        return (
            "⚠️ I couldn't finish that — I hit a problem partway "
            f"through.{ran} Here's how far I got:\n\n" + partial
        )
    return (
        "⚠️ I couldn't complete that — I hit a problem partway "
        f"through.{ran}"
    )


def _describe_completed_tools(
    tool_calls: Optional[List[Dict[str, Any]]],
    in_flight: Optional[Dict[str, Any]] = None,
) -> str:
    """Render the finished tool calls as a short clause, or '' when none ran.

    Deduplicated and capped: a turn that looped over 40 files should not paste
    40 identical names into a Chat message. When nothing completed we say so
    outright, because "nothing ran" is the single most useful thing a user can
    be told here — it means retrying is safe.
    """
    if not isinstance(tool_calls, list):
        return " Some steps may have already run, so please check before retrying."
    names = []
    # A record we cannot read is NOT evidence that nothing ran. Two ingestion
    # paths feed tool_calls and only the newer one normalizes `status`, so the
    # legacy tool_result stream can carry a terminal status we do not recognise
    # ("completed", "ok", …) or a missing name. Counting those as "nothing
    # happened" would tell the user a retry is safe when a Doc had already been
    # created — precisely the failure this function exists to prevent. So an
    # unreadable terminal record suppresses the safe-to-retry claim.
    unnamed_terminal = False
    # A tool that STARTED and never reported back is the most dangerous case,
    # not the safest: the request may have reached the broker and created the
    # Doc before the turn died, and its result event simply never arrived.
    # Started calls live in `tool_starts` and are removed from it when they
    # complete, so anything still there is genuinely in flight — and it never
    # appears in `tool_calls` at all, which is how an interrupted side effect
    # could leave that list empty and produce a "safe to retry".
    started_names = []
    if isinstance(in_flight, dict):
        for start in in_flight.values():
            if not isinstance(start, dict):
                unnamed_terminal = True
                continue
            name = start.get("name")
            if isinstance(name, str) and name and name != "unknown":
                if name not in started_names:
                    started_names.append(name)
            else:
                unnamed_terminal = True
    for call in tool_calls:
        if not isinstance(call, dict):
            unnamed_terminal = True
            continue
        if _tool_call_is_pending(call):
            continue
        name = call.get("name")
        if isinstance(name, str) and name and name != "unknown":
            if name not in names:
                names.append(name)
        else:
            unnamed_terminal = True
    # An in-flight call is reported as uncertain rather than as completed: we
    # know it was requested, not whether it landed.
    if started_names:
        started_shown = ", ".join(started_names[:3])
        started_more = (
            f" (+{len(started_names) - 3} more)" if len(started_names) > 3 else ""
        )
        started_note = (
            f" {started_shown}{started_more} was still running and may or may not "
            "have completed."
        )
    else:
        started_note = ""

    if not names:
        if started_names or unnamed_terminal:
            return (
                f"{started_note} Some steps may have already run, so please check "
                "before retrying."
            ).lstrip()
        return " Nothing had run yet, so it's safe to retry."
    shown = ", ".join(names[:5])
    more = f" (+{len(names) - 5} more)" if len(names) > 5 else ""
    unknown_note = " (and possibly others)" if unnamed_terminal else ""
    return (
        f" I had already run: {shown}{more}{unknown_note} — "
        f"please check those before retrying.{started_note}"
    )


# Statuses that mean a call had NOT finished when the turn died. Anything else
# terminal — including a status this build does not know — counts as completed,
# because assuming an unknown status means "did not run" is the unsafe
# direction.
_PENDING_TOOL_STATUSES = frozenset({"running", "pending", "started", "in_progress"})


def _normalize_tool_status(raw: Any, error: Any) -> str:
    """Collapse a wire status into "success" / "error" / a pending status.

    The item path already does this inline; the legacy tool_result path did not,
    so a completion could reach telemetry as "completed" or "ok".
    """
    if isinstance(raw, str) and raw.strip():
        lowered = raw.strip().lower()
        if lowered in _PENDING_TOOL_STATUSES:
            return lowered
        if lowered in ("error", "failed"):
            return "error"
        return "error" if error else "success"
    return "error" if error else "success"


def _tool_call_is_pending(call: dict) -> bool:
    status = call.get("status")
    if status is None:
        return False
    if not isinstance(status, str):
        return False
    return status.strip().lower() in _PENDING_TOOL_STATUSES


class HarnessAdapter(abc.ABC):
    """Abstract base class for agent harness adapters."""

    @abc.abstractmethod
    def process(
        self,
        message: str,
        session_id: str,
        model_override: Optional[str] = None,
        deadline_s: Optional[int] = None,
    ) -> Union[str, TurnResult]:
        """Send a message to the harness and return either a plain string
        (legacy contract) or a TurnResult (preferred). Wrapper accepts
        both. `deadline_s` (async-job path, #1138) overrides the turn
        deadline; None keeps the interactive default."""

    @abc.abstractmethod
    def configure(self, config: dict) -> None:
        """Apply runtime configuration to the harness."""

    @abc.abstractmethod
    def health(self) -> bool:
        """Return True if the harness is ready to accept messages."""

    @abc.abstractmethod
    def shutdown(self) -> None:
        """Gracefully stop the harness process."""


class OpenClawAdapter(HarnessAdapter):
    """
    Adapter for OpenClaw running in the same container.

    Communicates with the OpenClaw gateway via its native WebSocket protocol.
    Based on the AWS sample: aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore

    Protocol:
    1. Connect to ws://127.0.0.1:{port}
    2. Respond to connect.challenge with auth token
    3. Send chat.send with the user message
    4. Collect chat events until state: "final"
    """

    DEFAULT_CONFIG_PATH = "/home/node/.openclaw/openclaw.json"
    # Root of the OpenClaw workspace in this container. Transcripts (the
    # token-usage ground truth — see _read_turn_usage) live in the per-agent
    # SQLite database at
    # <WORKSPACE_DIR>/agents/<agentId>/agent/openclaw-agent.sqlite, table
    # transcript_events. Hosts before 2026.7.2-beta.5 instead appended one JSONL
    # file per session at <WORKSPACE_DIR>/agents/<agentId>/sessions/<id>.jsonl;
    # that path is still read as a fallback when the SQLite DB is absent.
    WORKSPACE_DIR = "/home/node/.openclaw"
    # Filename of the per-agent transcript database, relative to
    # <WORKSPACE_DIR>/agents/<agentId>/agent/. A CONSTANT, not derived from the
    # gateway event stream — only the agentId directory component is untrusted
    # input, and the sessionId is a bound SQL parameter rather than a path
    # component (a strict improvement on the JSONL layout, where it was both).
    TRANSCRIPT_DB_SUBDIR = "agent"
    TRANSCRIPT_DB_FILENAME = "openclaw-agent.sqlite"
    # Bounded settle for the transcript read: 6 x 200ms = 1.0s worst case, paid
    # only when the turn-ending assistant record hasn't landed yet.
    USAGE_SETTLE_ATTEMPTS = 6
    USAGE_SETTLE_INTERVAL_S = 0.2
    # Per-connection busy timeout for the transcript read. The runtime writes
    # this DB in WAL mode, so a reader does not block on a concurrent writer;
    # this only bounds the rare case of a writer holding the exclusive lock for
    # a checkpoint. Kept well under one settle interval so a busy DB retries via
    # the settle loop rather than stalling the turn.
    USAGE_SQLITE_TIMEOUT_S = 0.1
    # Gateway auth token is generated per container at startup (see __init__),
    # never hardcoded. It is passed to the gateway via the --token CLI flag and
    # reused by this adapter's connect envelope, so launcher and client always
    # agree within the process. OpenClaw overwrites the config file's token on
    # startup and --token overrides that config value, so the on-disk config
    # token is never the operative secret.
    # The image contract chooses the identity supported by its pinned host.
    # Production 2026.7.2-beta.5 uses OpenClaw's supported local-backend
    # identity; harness candidates may select another explicitly approved pair
    # for their pinned host. These loopback identities preserve operator scopes
    # without classifying this non-browser adapter as Control UI.
    _gateway_client_pair = (
        os.environ.get("PSD_OPENCLAW_GATEWAY_CLIENT_ID", "gateway-client"),
        os.environ.get("PSD_OPENCLAW_GATEWAY_CLIENT_MODE", "backend"),
    )
    if _gateway_client_pair not in {
        ("gateway-client", "backend"),
        ("openclaw-tui", "backend"),
        ("cli", "cli"),
    }:
        raise RuntimeError("Unsupported OpenClaw gateway client identity")
    CLIENT_INFO = {
        "id": _gateway_client_pair[0],
        "mode": _gateway_client_pair[1],
        "version": "dev",
        "platform": "linux",
    }

    def __init__(self) -> None:
        self._gateway_port: int = 3100
        self._process: Optional[subprocess.Popen] = None
        self._process_group_id: Optional[int] = None
        self._ready: bool = False
        # Per-container random gateway token (REV-INFRA-005). Generated once at
        # startup so it is never committed to source and never readable by the
        # sandboxed `node` agent from a static file. Passed to `openclaw gateway
        # --token` (launcher) and reused in the connect envelope (client), so the
        # two always agree within this process.
        self._gateway_token: str = secrets.token_urlsafe(32)

    def configure(self, config: dict) -> None:
        """Configure the OpenClaw adapter. Idempotent — safe to call multiple times."""
        if "gateway_port" in config:
            self._gateway_port = config["gateway_port"]

            if self._process is None or self._process.poll() is not None:
                logger.info("Starting OpenClaw gateway on port %d", self._gateway_port)
                # Pass --token on CLI so it survives config overwrites.
                # OpenClaw overwrites openclaw.json on startup, generating a
                # new random token. The --token CLI flag overrides the config
                # file value, ensuring the adapter and gateway always agree.
                self._process = subprocess.Popen(
                    [
                        "openclaw", "gateway",
                        "--port", str(self._gateway_port),
                        "--token", self._gateway_token,
                    ],
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                    env={
                        **{
                            key: value
                            for key, value in os.environ.items()
                            if key not in {
                                "AGENT_INVOCATION_SIGNING_SECRET",
                                "AGENT_INVOCATION_SIGNING_SECRET_ID",
                                "PSD_INVOCATION_CONTEXT_FILE",
                                "PSD_INVOCATION_REQUEST_PROOF_KEY_FILE",
                                "AWS_BEARER_TOKEN_BEDROCK",
                                "BEDROCK_API_KEY_SECRET_ARN",
                                "CANDIDATE_MANTLE_BEARER_TOKEN",
                            }
                        },
                        "HOME": "/home/node",
                        "OPENCLAW_NO_RESPAWN": "1",
                    },
                    user="node",
                    group="node",
                    extra_groups=[],
                    umask=0o077,
                    cwd="/home/node",
                    start_new_session=True,
                )
                self._process_group_id = self._process.pid
                self._wait_for_ready(timeout=60)
                # Give the gateway time to fully initialize WebSocket handling
                time.sleep(3)

    def _wait_for_ready(self, timeout: int = 60) -> None:
        """Poll the gateway health endpoint until ready.

        Accept ANY HTTP response (including 401/403) as "ready" — newer
        OpenClaw builds protect /health behind the gateway auth token,
        returning 401 unauthenticated. Since we only need to know the
        server is up and answering, any HTTP status is sufficient proof.
        A connection error (ECONNREFUSED) still means the gateway isn't
        listening yet and we keep polling.
        """
        import http.client
        import socket

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                conn = http.client.HTTPConnection(
                    "127.0.0.1", self._gateway_port, timeout=2,
                )
                conn.request("GET", "/health")
                resp = conn.getresponse()
                _ = resp.read()  # drain
                conn.close()
                # Any HTTP response means the gateway is accepting connections.
                self._ready = True
                logger.info(
                    "OpenClaw gateway is ready (health status=%d)", resp.status,
                )
                return
            except (ConnectionRefusedError, socket.timeout, OSError):
                pass
            time.sleep(1)

        raise RuntimeError(
            f"OpenClaw gateway did not become ready within {timeout}s"
        )

    @staticmethod
    def _open_gateway_socket(websocket_module: Any, ws_url: str) -> Any:
        """Open the adapter's non-browser loopback WebSocket.

        websocket-client adds an Origin header unless told otherwise. Newer
        OpenClaw releases deliberately treat any Origin-bearing connection as
        browser-originated and therefore refuse approved local-backend auth
        paths. This adapter is a backend client on the same container loopback,
        not a browser, so suppress the synthetic header instead of weakening
        the gateway's browser-origin checks.
        """
        return websocket_module.create_connection(
            ws_url,
            timeout=120,
            suppress_origin=True,
        )

    def _fold_usage_records(
        self, raw_records: Iterable[str], since_ms: int,
    ) -> Tuple[Dict[str, int], bool]:
        """Fold serialized transcript records into this turn's usage totals.

        `raw_records` yields the JSON text of each transcript record in APPEND
        order (JSONL line order, or `transcript_events` ordered by `seq`). The
        record shape is identical in both stores — the SQLite migration moved
        the same objects verbatim into `event_json` (verified against a
        checkpointed 2026.7.2-beta.5 database).

        Returns `(totals, complete)`. `complete` is True only when the newest
        in-window assistant record THAT CARRIES A stopReason carries an
        explicitly allowlisted terminal one. OpenClaw writes
        `stopReason: "toolUse"` on every model call that hands off to a tool and
        "stop"/"end_turn" only on the call that ends the turn, so a novel value
        cannot accidentally become a "no more model calls coming" signal.

        Completeness is deliberately decided independently of whether the record
        also carries `usage`. Deciding it from the last record WITH usage — the
        obvious reading, and what this did first — silently mis-reports any turn
        whose terminal record has no usage object: the preceding `toolUse` call
        wins and the turn reports incomplete despite having finished. That both
        pays the full settle budget on a turn that was already done and writes a
        FALSE into `agent_messages.usage_capture_complete`, which per migration
        177 means "these token columns are a floor, not a total" — manufacturing
        the exact broken-capture signature the alarm exists to catch. Records
        with NO stopReason at all leave completeness untouched rather than
        clearing it, so a trailing non-model-call record cannot un-finish a
        finished turn either.

        Raises nothing of its own; errors from the underlying store surface as
        exceptions from `raw_records` and are handled by the callers.
        """
        totals = {"input": 0, "output": 0, "cache_read": 0,
                  "cache_write": 0, "model_calls": 0}
        complete = False
        for raw in raw_records:
            raw = raw.strip()
            if not raw:
                continue
            try:
                record = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                # A torn final JSONL line is expected when we read while the
                # runtime is mid-append; a malformed `event_json` is a
                # corrupt/unknown row. Either way clear completeness in case a
                # prior terminal record was followed by a new partial
                # model-call record; the settle loop will re-read once it
                # lands whole.
                complete = False
                continue
            if not isinstance(record, dict):
                continue
            msg = record.get("message")
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            # The in-window test comes BEFORE the usage test so an out-of-window
            # record can never reach the completeness update below and report a
            # previous turn's ending as this turn's.
            ts_ms = self._record_timestamp_ms(record, msg)
            if ts_ms is None or ts_ms < since_ms:
                continue
            usage = msg.get("usage")
            if isinstance(usage, dict):
                totals["model_calls"] += 1
                for key, field in (
                    ("input", "input"),
                    ("output", "output"),
                    ("cache_read", "cacheRead"),
                    ("cache_write", "cacheWrite"),
                ):
                    value = usage.get(field)
                    # bool is an int subclass; a JSON `true` must not add 1
                    # token.
                    if isinstance(value, int) and not isinstance(value, bool) \
                            and value > 0:
                        totals[key] += value
            stop_reason = msg.get("stopReason")
            if stop_reason is not None:
                # Recomputed per stopReason-bearing record so the LAST one wins:
                # an earlier terminal reason followed by more model calls
                # (nudge/compaction legs) must not latch `complete` True. A
                # record without a stopReason is not a turn-boundary signal at
                # all, so it leaves the verdict alone.
                complete = stop_reason in TERMINAL_USAGE_STOP_REASONS
        return totals, complete

    def _sum_sqlite_transcript_usage(
        self, db_path: str, session_uuid: str, since_ms: int,
    ) -> Tuple[Dict[str, int], bool]:
        """Sum this turn's usage from the `transcript_events` table.

        Opened through a read-only `file:` URI so a telemetry read can never
        create, migrate, or write the runtime's database — SQLite refuses any
        mutation on an `mode=ro` connection, and `mode=ro` (unlike the default)
        also refuses to CREATE the file if it is missing.

        `session_id` is a bound parameter, never interpolated. `created_at` is
        an epoch-ms INTEGER written when the row is inserted, which is always
        at or after the record's own `message.timestamp` (verified across a
        real database: 488 records, 0 inversions, skew 0..20s). That makes
        `created_at >= since_ms` a safe SUPERSET prefilter — it narrows the scan
        without ever hiding an in-window record, and the authoritative
        in-window test stays on the record timestamp in `_fold_usage_records`,
        exactly as the JSONL path did.

        The obvious way that invariant could break is the 2026.7.2-beta.5 import
        stamping migrated JSONL records with the MIGRATION time instead of the
        original. It does not: the same database holds events from 2026-07-27
        (before its 2026-07-30 import) and not one row has a skew above 60s.
        Even if a future migration did stamp import time, a too-LARGE created_at
        only widens the prefilter, so the record-timestamp filter still decides
        and the result stays correct — which is precisely why the authoritative
        test was left on the record timestamp rather than moved into SQL.

        Ordering is `seq`, the append order — NOT `created_at`, which is only
        weakly ordered with respect to it (28 of 32 sessions in the same real
        database contain at least one row whose `created_at` precedes that of a
        lower `seq`). `complete` depends on which record is LAST, so ordering by
        the wrong column would mis-read turn completeness.

        Raises `TranscriptTableMissing` when the database predates the
        `transcript_events` table, and propagates `sqlite3.OperationalError` for
        a locked/busy database. The caller must treat these differently: the
        first means fall back to JSONL, the second means retry.
        """
        # `timeout` bounds the wait for a writer's exclusive lock. WAL readers
        # do not block on ordinary writes, so this is effectively only paid
        # during a checkpoint.
        # as_uri() percent-encodes characters that are structural in a URI
        # (notably `?` and `#`), so a workspace path containing one cannot be
        # read as a query parameter. Requires an absolute path — callers pass a
        # realpath.
        connection = sqlite3.connect(
            f"{pathlib.Path(db_path).as_uri()}?mode=ro",
            uri=True,
            timeout=self.USAGE_SQLITE_TIMEOUT_S,
        )
        try:
            # Probe the schema first so "this host has no transcript_events"
            # cannot be confused with "the table is momentarily locked" — both
            # surface as OperationalError from a plain SELECT, but only one is
            # worth retrying.
            if not connection.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'transcript_events'",
            ).fetchone():
                raise TranscriptTableMissing(db_path)
            cursor = connection.execute(
                "SELECT event_json FROM transcript_events "
                "WHERE session_id = ? AND created_at >= ? "
                "ORDER BY seq",
                (session_uuid, since_ms),
            )
            return self._fold_usage_records(
                (row[0] for row in cursor if isinstance(row[0], str)),
                since_ms,
            )
        finally:
            connection.close()

    def _sum_transcript_usage(
        self, path: str, since_ms: int,
    ) -> Tuple[Dict[str, int], bool]:
        """Sum assistant-message usage in the JSONL transcript at `path`.

        Legacy path, retained for hosts older than 2026.7.2-beta.5 (which moved
        transcripts into SQLite). Never raises.
        """
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return self._fold_usage_records(fh, since_ms)
        except OSError as exc:
            logger.warning(
                "transcript usage read failed: %s", str(exc)[:200],
            )
        return (
            {"input": 0, "output": 0, "cache_read": 0,
             "cache_write": 0, "model_calls": 0},
            False,
        )

    @staticmethod
    def _record_timestamp_ms(record: dict, msg: dict) -> Optional[int]:
        """Epoch-ms timestamp of a transcript record, or None if unreadable."""
        ts = msg.get("timestamp")
        if isinstance(ts, (int, float)):
            return int(ts)
        # Top-level transcript timestamps are ISO-8601 with a trailing Z, which
        # fromisoformat only accepts from 3.11 — normalize for older runtimes.
        ts = record.get("timestamp")
        if isinstance(ts, str) and ts:
            try:
                parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                return None
            return int(parsed.timestamp() * 1000)
        return None

    def _read_turn_usage(
        self,
        session_uuid: Optional[str],
        agent_id: Optional[str],
        since_ms: int,
    ) -> Dict[str, object]:
        """Read this turn's usage, guaranteeing that no exception escapes.

        The implementation below degrades every failure mode it ANTICIPATES to
        zeros. This wrapper is what makes the promise hold for the ones it does
        not, and it belongs on the callee rather than at each call site: the
        success-path caller runs after the WebSocket try/except has already
        closed, so an escaping exception there would throw away a reply the model
        had already produced. Worse, that turn's tool calls have run, so any
        higher-level retry would re-run their side effects — the precise outcome
        `_should_retry_upstream` is written to avoid. An unforeseen error (an
        OverflowError out of an absurd ISO timestamp, a future non-defensive
        edit to the fold) must cost the telemetry, never the turn.
        """
        try:
            return self._read_turn_usage_unguarded(
                session_uuid, agent_id, since_ms,
            )
        except Exception as exc:  # noqa: BLE001 - telemetry must never break a turn
            logger.warning(
                "transcript usage read raised unexpectedly: %s", str(exc)[:200],
            )
            return {"input": 0, "output": 0, "cache_read": 0,
                    "cache_write": 0, "model_calls": 0,
                    "capture_complete": False}

    def _read_turn_usage_unguarded(
        self,
        session_uuid: Optional[str],
        agent_id: Optional[str],
        since_ms: int,
    ) -> Dict[str, object]:
        """Read this turn's real token usage from the OpenClaw session transcript.

        This is the ground-truth capture point after #1159/#1384 moved chat off
        the Mantle proxy: the gateway's WebSocket event stream carries NO usage
        (verified against the 2026.7.1-beta.2 protocol — neither `event:chat`
        state=final nor any `event:agent` lifecycle payload includes a usage
        object), so the old WS-scraping path could only ever report 0. The
        runtime does persist per-model-call usage — input / output / cacheRead /
        cacheWrite — onto each assistant record in
        `<workspace>/agents/<agentId>/sessions/<sessionId>.jsonl`, which is
        local to this container and written with plain appends (no userspace
        buffering), so it is readable the moment the runtime writes it.

        As of OpenClaw 2026.7.2-beta.5 those records live in the per-agent
        SQLite database `<workspace>/agents/<agentId>/agent/openclaw-agent.sqlite`
        (table `transcript_events`, one row per record with the SAME JSON object
        the JSONL file used to hold). The per-session JSONL files were migrated
        into it and REMOVED, which silently zeroed this telemetry until this
        read followed them. Older hosts are still supported via the JSONL
        fallback below.

        The turn window is `[since_ms, now]` — the caller passes the chat.send
        wall clock, and every model call this turn is stamped after it. The
        wrapper reads this BEFORE any nudge leg is sent, so the nudge's own
        window cannot overlap and the two are summed rather than double-counted.

        Known under-count: if the session rotates mid-turn (compaction), the
        last sessionId seen on the event stream names the NEW transcript and
        the pre-rotation model calls are not billed. Preferred over the
        alternative failure mode — reading a stale file and billing another
        turn's calls twice.

        Returns zeros with capture_complete=False on any failure; telemetry
        must never break a chat turn.
        """
        empty = {"input": 0, "output": 0, "cache_read": 0,
                 "cache_write": 0, "model_calls": 0,
                 "capture_complete": False}
        if not session_uuid:
            logger.warning(
                "transcript usage skipped — no sessionId on the event stream",
            )
            return empty
        # The session/agent ids arrive on the gateway event stream, so treat
        # them as untrusted path input. The charset alone is NOT sufficient:
        # `.` is a legal id character, so ".." satisfies the regex and
        # `<workspace>/agents/../sessions/<id>.jsonl` normalizes one directory
        # above the intended agent — enough to read and bill another
        # transcript. Reject dot-only components explicitly.
        if not _is_safe_path_component(session_uuid) or (
            agent_id and not _is_safe_path_component(agent_id)
        ):
            logger.warning("transcript usage skipped — unsafe session/agent id")
            return empty

        agent_dir = os.path.join(self.WORKSPACE_DIR, "agents", agent_id or "main")

        # Preferred source: the per-agent transcript database. Contained the
        # same way as the JSONL path below — the resolved file must sit directly
        # beneath the resolved `agent/` directory, which rejects a SYMLINKED
        # database pointing out of the workspace.
        db_dir = os.path.join(agent_dir, self.TRANSCRIPT_DB_SUBDIR)
        db_path = self._contained_transcript_path(
            db_dir, self.TRANSCRIPT_DB_FILENAME,
        )
        if db_path is not None:
            try:
                return self._settle_usage(
                    lambda: self._sum_sqlite_transcript_usage(
                        db_path, session_uuid, since_ms,
                    ),
                    session_uuid,
                )
            except TranscriptTableMissing:
                # Pre-2026.7.2-beta.5 host: the database exists for other state
                # but transcripts are still per-session JSONL. Fall through
                # rather than report zeros.
                logger.info(
                    "transcript database has no transcript_events — falling "
                    "back to the JSONL transcript",
                )

        sessions_dir = os.path.join(agent_dir, "sessions")
        jsonl_path = self._contained_transcript_path(
            sessions_dir, f"{session_uuid}.jsonl",
        )
        if jsonl_path is None:
            logger.warning(
                "transcript usage skipped — no transcript database at %s and no "
                "JSONL transcript for session %s",
                db_dir, session_uuid,
            )
            return empty

        return self._settle_usage(
            lambda: self._sum_transcript_usage(jsonl_path, since_ms),
            session_uuid,
        )

    @staticmethod
    def _contained_transcript_path(
        directory: str, filename: str,
    ) -> Optional[str]:
        """Resolve `directory/filename`, or None if missing or uncontained.

        Containment: the resolved file must sit directly beneath the resolved
        directory. Mirrors the Zip-Slip containment workspace_sync.py applies to
        restore paths, and catches a SYMLINKED transcript.

        It does NOT substitute for the dot-name rejection in the caller.
        `directory` is built from the same untrusted agent_id, so an agent_id of
        ".." moves BOTH sides of this comparison to the escaped directory and
        they match — the check would pass on a path that already climbed out.
        The component check is what stops that vector; this is defence against a
        different one. (test_dot_dot_agent_id_cannot_climb_out_of_the_agent_
        directory fails if the dot-name rejection is removed, even with this
        check in place — verified, not assumed.)
        """
        path = os.path.join(directory, filename)
        resolved = os.path.realpath(path)
        if os.path.dirname(resolved) != os.path.realpath(directory):
            logger.warning(
                "transcript usage skipped — resolved path escapes %s", directory,
            )
            return None
        if not os.path.exists(resolved):
            return None
        return resolved

    def _settle_usage(
        self,
        read: "Callable[[], Tuple[Dict[str, int], bool]]",
        session_uuid: str,
    ) -> Dict[str, object]:
        """Retry `read` on a bounded schedule until the turn reads complete.

        OpenClaw appends the turn-ending assistant record before it emits the
        chat `final` event we broke out on, so the first read almost always
        lands complete. The settle loop only covers the append/emit race (and,
        on the SQLite path, a momentarily locked database); a turn that made no
        model calls at all (aborted pre-inference) never goes `complete` and
        pays the full bounded wait before returning its honest zeros.

        Telemetry must never break a chat turn, so an unreadable store degrades
        to partial totals rather than propagating. The one exception is
        `TranscriptTableMissing`, which is allowed through: it is not a read
        failure but a signal that the caller should try the other store.
        """
        totals: Dict[str, int] = {
            "input": 0, "output": 0, "cache_read": 0,
            "cache_write": 0, "model_calls": 0,
        }
        # Seeded alongside `totals` so the corrupt-database fast-break below is
        # self-contained. Nothing after the loop reads it today, but a future
        # edit returning `complete` instead of a literal would otherwise raise
        # UnboundLocalError on exactly the path that is hardest to reach.
        complete = False
        for attempt in range(self.USAGE_SETTLE_ATTEMPTS):
            try:
                totals, complete = read()
            except sqlite3.OperationalError as exc:
                # Locked or busy database — retry, since a checkpoint clears in
                # ms. A host whose schema predates `transcript_events` does NOT
                # arrive here: the sqlite_master probe raises
                # TranscriptTableMissing for that, precisely so the retryable
                # and fall-back-to-JSONL cases stay distinguishable.
                logger.warning(
                    "transcript usage read unavailable: %s", str(exc)[:200],
                )
                complete = False
            except sqlite3.DatabaseError as exc:
                # Corrupt or non-SQLite file: retrying cannot help.
                logger.warning(
                    "transcript usage read failed: %s", str(exc)[:200],
                )
                break
            if complete:
                return {**totals, "capture_complete": True}
            if attempt < self.USAGE_SETTLE_ATTEMPTS - 1:
                time.sleep(self.USAGE_SETTLE_INTERVAL_S)
        logger.warning(
            "transcript usage did not settle within %.1fs — reporting partial "
            "(model_calls=%d session=%s)",
            (self.USAGE_SETTLE_ATTEMPTS - 1) * self.USAGE_SETTLE_INTERVAL_S,
            totals["model_calls"],
            session_uuid,
        )
        return {**totals, "capture_complete": False}

    def process(
        self,
        message: str,
        session_id: str,
        model_override: Optional[str] = None,
        deadline_s: Optional[int] = None,
        _is_nudge: bool = False,
    ) -> TurnResult:
        """Run one turn, retrying once when the UPSTREAM model call fails
        before any work happened.

        On 2026-08-06 Bedrock returned 5xx for ~25 minutes (CloudWatch
        InvocationServerErrors peaked at 26/5min, InvocationThrottles stayed
        at zero — a server fault, not our quota). It cost 27 turns across 9
        users. Every one of them died in ~6 seconds having executed NOTHING:
        no tool calls, no output. A transient upstream fault at that point is
        the one failure a turn can safely repeat, because there is nothing to
        repeat.

        Deliberately narrow. `_should_retry_upstream` demands the turn be
        provably side-effect-free, so this never re-runs work: a turn that
        already created a Doc is not retried, whatever it failed with.
        """
        started_at = time.monotonic()
        attempt = self._process_once(
            message, session_id, model_override, deadline_s, _is_nudge
        )
        if not self._should_retry_upstream(attempt):
            return attempt
        # Wall clock, not attempt.latency_ms: latency is measured from
        # chat.send and so misses connection setup, which the retry must also
        # pay for a second time.
        elapsed_s = time.monotonic() - started_at
        remaining_s = int(
            self._resolve_deadline_s(deadline_s) - elapsed_s - UPSTREAM_RETRY_DELAY_S
        )
        if remaining_s < UPSTREAM_RETRY_MIN_REMAINING_S:
            logger.warning(
                "skipping upstream retry — only %ds of the turn budget left: "
                "error_class=%s",
                remaining_s,
                attempt.error_class,
            )
            return attempt
        logger.warning(
            "retrying turn after a clean upstream failure: error_class=%s "
            "latency_ms=%d retry_deadline_s=%d",
            attempt.error_class,
            attempt.latency_ms,
            remaining_s,
        )
        time.sleep(UPSTREAM_RETRY_DELAY_S)
        retried = self._process_once(
            message, session_id, model_override, remaining_s, _is_nudge
        )
        if retried.failed:
            # Keep the retry's result — it is the more recent evidence — but
            # say plainly that a retry happened, so a two-failure turn is not
            # read as a single blip.
            logger.error(
                "upstream retry also failed: first=%s second=%s",
                attempt.error_class,
                retried.error_class,
            )
            return retried
        logger.info("upstream retry recovered the turn")
        return retried

    @staticmethod
    def _should_retry_upstream(result: TurnResult) -> bool:
        """True only when replaying the turn cannot repeat a side effect.

        ALL must hold: the turn failed; it failed as a generic upstream chat
        error (not a deadline, overflow, or the incomplete-tool-turn class,
        each of which OpenClaw already handles its own way); no tool call was
        recorded AND none was still in flight; and it died fast enough that the
        failure was the model call itself rather than something that happened
        mid-work.

        `tools_in_flight` is not redundant with `tool_calls`. A tool that
        started and never reported a terminal result is dropped from
        `tool_calls` entirely, so a turn that had already asked the broker to
        create a Doc can present an EMPTY tool_calls list. Retrying that would
        create the Doc twice.
        """
        if not result.failed:
            return False
        if result.error_class != "OpenClawChatError":
            return False
        if result.tool_calls or result.tools_in_flight:
            return False
        return result.latency_ms <= UPSTREAM_RETRY_MAX_LATENCY_MS

    def _process_once(
        self,
        message: str,
        session_id: str,
        model_override: Optional[str] = None,
        deadline_s: Optional[int] = None,
        _is_nudge: bool = False,
    ) -> TurnResult:
        """Send a message to OpenClaw via WebSocket and return a TurnResult.

        Uses the native OpenClaw gateway WebSocket protocol:
        connect.challenge → connect (auth) → chat.send → collect chat events

        Captures (best-effort) the real model id, token usage, tool calls,
        and latency from the event stream so the router Lambda can write
        proper telemetry into agent_messages + agent_message_content +
        agent_tool_invocations.
        """
        if not self._ready:
            raise RuntimeError(
                "OpenClaw gateway is not ready — configure() with gateway_port "
                "must be called before process()"
            )

        # Track metadata across the whole turn. The user message is the
        # first content entry; we'll append assistant + tool entries as
        # the event stream completes.
        observed_model: Optional[str] = model_override
        # OpenClaw's internal session UUID + agent id, learned from the
        # gateway's lifecycle events. They name the transcript file this turn's
        # token usage is read back from (see _read_turn_usage) — our sessionKey
        # is NOT the filename.
        observed_session_uuid: Optional[str] = None
        observed_agent_id: Optional[str] = None
        tokens_in = 0
        tokens_out = 0
        cache_read = 0
        cache_write = 0
        tool_calls: List[Dict[str, Any]] = []
        tool_starts: Dict[str, Dict[str, Any]] = {}
        messages_log: List[Dict[str, Any]] = [
            {"role": "user", "content": message}
        ]

        try:
            import websocket  # websocket-client library
        except ImportError:
            logger.error("websocket-client not installed, falling back to error")
            return TurnResult(
                text="Agent communication library not available. Please contact an administrator.",
                model=observed_model,
            )

        gateway_token = self._gateway_token
        ws_url = f"ws://127.0.0.1:{self._gateway_port}"
        response_text = ""

        # Retry WebSocket connection up to 3 times — the gateway may still
        # be initializing WebSocket handling even after /health returns 200.
        ws = None
        last_error = None
        for attempt in range(3):
            try:
                ws = self._open_gateway_socket(websocket, ws_url)
                break
            except Exception as exc:
                last_error = exc
                logger.warning("WS connect attempt %d failed: %s", attempt + 1, exc)
                time.sleep(2)

        if ws is None:
            logger.error("Failed to connect to gateway after 3 attempts: %s", last_error)
            return TurnResult(
                text=f"I'm temporarily unable to respond. Error: {str(last_error)[:100]}",
                model=observed_model,
            )

        try:

            try:
                # Step 1: Wait for connect.challenge
                challenge_raw = ws.recv()
                challenge = json.loads(challenge_raw)
                if challenge.get("type") != "event" or challenge.get("event") != "connect.challenge":
                    raise RuntimeError(
                        f"Unexpected initial WebSocket message: {challenge_raw[:300]}"
                    )

                # Step 2: Authenticate
                connect_id = str(uuid.uuid4())
                connect_req = {
                    "type": "req",
                    "id": connect_id,
                    "method": "connect",
                    "params": {
                        # OpenClaw 2026.6.11's gateway moved to WS protocol v4
                        # (PROTOCOL_VERSION=4); it rejects any [minProtocol,
                        # maxProtocol] range that does not include its current
                        # protocol (the pin at 3/3 produced PROTOCOL_MISMATCH /
                        # WS_AUTH_FAIL after the bump). Advertise [3,4] per the
                        # gateway protocol docs so we negotiate v4 against this
                        # gateway yet stay compatible with a v3 gateway on
                        # rollback. The v4 connect envelope + fields below are
                        # unchanged. The harness-selected supported loopback
                        # identity authenticates with the per-process shared
                        # token, so no interactive operator-UI device identity
                        # is involved.
                        "minProtocol": 3,
                        "maxProtocol": 4,
                        "client": self.CLIENT_INFO,
                        "caps": [],
                        "auth": {"token": gateway_token},
                        "role": "operator",
                        "scopes": ["operator.admin", "operator.read", "operator.write"],
                    },
                }
                ws.send(json.dumps(connect_req))

                # Wait for connect response — skip non-res messages
                while True:
                    connect_resp_raw = ws.recv()
                    connect_resp = json.loads(connect_resp_raw)
                    if connect_resp.get("type") == "res" and connect_resp.get("id") == connect_id:
                        break

                if not connect_resp.get("ok"):
                    return TurnResult(
                        text=f"[WS_AUTH_FAIL] {json.dumps(connect_resp)[:800]}",
                        model=observed_model,
                    )

                # Diagnostic: ask the gateway what tools are actually
                # wired for the default agent. If the model says "let me
                # check" but never calls a tool, it's usually because the
                # tools.catalog is empty for this session.
                try:
                    catalog_id = str(uuid.uuid4())
                    ws.send(json.dumps({
                        "type": "req",
                        "id": catalog_id,
                        "method": "tools.catalog",
                        "params": {},
                    }))
                    # Drain until we see this req's response
                    catalog_deadline = time.time() + 10
                    while time.time() < catalog_deadline:
                        raw_c = ws.recv()
                        msg_c = json.loads(raw_c)
                        if msg_c.get("type") == "res" and msg_c.get("id") == catalog_id:
                            if msg_c.get("ok"):
                                payload = msg_c.get("payload", {})
                                tools = payload.get("tools") or payload.get("grouped") or payload
                                names = _catalog_tool_names(tools)
                                logger.info(
                                    "tools.catalog ok: %s",
                                    json.dumps(
                                        {"names": names},
                                        separators=(",", ":"),
                                    ),
                                )
                            else:
                                logger.warning(
                                    "tools.catalog error: %s",
                                    json.dumps(msg_c.get("error", {}))[:500],
                                )
                            break
                except Exception as exc:  # noqa: BLE001
                    logger.warning("tools.catalog probe failed: %s", str(exc)[:200])

                # Step 2.5: Defensively abort any lingering reply session for
                # this sessionKey before sending (#session-conflict fix).
                #
                # OpenClaw keys its server-side reply session on sessionKey,
                # which we reuse across turns (the stable AgentCore session_id).
                # A prior turn's reply session can survive that turn's
                # ws.close() and then reject the next chat.send with "reply
                # session initialization conflicted" — observed 2026-07-01,
                # where every follow-up turn returned "I encountered an error."
                # The router already serializes turns per session (a DynamoDB
                # session lock; see agent-router waitForSessionLock), so no
                # legitimate work for this sessionKey is active here — a
                # pre-send chat.abort is therefore safe and clears the wedged
                # state. chat.abort takes `sessionKey` per the OpenClaw gateway
                # protocol (sessions.reset would additionally wipe stored
                # conversation state, so we deliberately do NOT use it here).
                # Kill switch: OPENCLAW_PRESEND_ABORT=0.
                if os.environ.get("OPENCLAW_PRESEND_ABORT", "1") != "0":
                    try:
                        abort_id = str(uuid.uuid4())
                        ws.send(json.dumps({
                            "type": "req",
                            "id": abort_id,
                            "method": "chat.abort",
                            "params": {"sessionKey": session_id or "default"},
                        }))
                        # Drain until the abort ack (bounded ~5s). Any
                        # intervening `aborted` chat event for the stale session
                        # is consumed here so it can't leak into the chat.send
                        # event loop below. The main loop resets settimeout(60).
                        ws.settimeout(5)
                        abort_deadline = time.time() + 5
                        while time.time() < abort_deadline:
                            try:
                                raw_a = ws.recv()
                            except websocket.WebSocketTimeoutException:
                                break
                            try:
                                msg_a = json.loads(raw_a)
                                if (isinstance(msg_a, dict)
                                        and msg_a.get("type") == "res"
                                        and msg_a.get("id") == abort_id):
                                    logger.info(
                                        "pre-send chat.abort ack: ok=%s",
                                        msg_a.get("ok"),
                                    )
                                    break
                            except (json.JSONDecodeError, ValueError):
                                continue
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "pre-send chat.abort failed (continuing): %s",
                            str(exc)[:200],
                        )

                # Step 3: Send chat message
                #
                # sessionKey MUST be per-invocation caller, not "global".
                # OpenClaw uses sessionKey to key its conversation state, so
                # sharing "global" across every Google Chat user and every
                # turn causes cross-contamination: turn N inherits turn N-1's
                # half-finished tool calls, error markers, and (in the
                # multi-user case) other users' history entirely. The
                # AgentCore runtime gives us a stable per-user session_id;
                # use it directly.
                chat_id = str(uuid.uuid4())
                # Latency clock starts the instant we hand the message to
                # the gateway. final_state event stops it. Captured before
                # ws.send so we don't count our own serialization.
                chat_send_at = time.time()
                ws.send(json.dumps({
                    "type": "req",
                    "id": chat_id,
                    "method": "chat.send",
                    "params": {
                        "sessionKey": session_id or "default",
                        "message": message,
                        "idempotencyKey": chat_id,
                    },
                }))

                # Step 4: Collect response events until final.
                # Instrumented to log every event type we see so we can
                # understand what OpenClaw is actually emitting when a turn
                # hangs (CloudWatch only — no secrets leak).
                #
                # Deadline sizing: the enclosing interactive budget is a
                # 15-minute Router Lambda, but the terminal SSE result is now
                # withheld until OpenClaw stops and the final workspace
                # checkpoint is durably pushed. Reserve 350 seconds outside
                # this turn for AgentCore cold start, the bounded proxy restart
                # and 125-second workspace flush, and Chat delivery. Long work
                # that reaches this roughly nine-minute ceiling returns early
                # for the router to promote it to the two-hour job path.
                #
                # OPENCLAW_CHAT_DEADLINE_S env override for escape hatch,
                # clamped to [60, 550] so a misconfig cannot consume the
                # finalization reserve. Explicit async-job overrides retain
                # their independently bounded two-hour ceiling.
                deadline_s = self._resolve_deadline_s(deadline_s)
                deadline = time.time() + deadline_s
                got_final = False
                event_counts: dict = {}
                first_event_types: list = []
                last_state: Optional[str] = None
                last_payload_sample: str = ""
                raw_event_samples: list = []
                # OpenClaw reports the real reason for an aborted chat on the
                # agent lifecycle stream before the chat channel emits only
                # `{state: "aborted", stopReason: "stop"}`. Preserve the
                # lifecycle error so an overflow is not mislabeled as a turn
                # deadline (issue #1461).
                last_lifecycle_error: Optional[str] = None
                chat_aborted = False
                abort_stop_reason: Optional[str] = None
                # Accumulator for streaming assistant deltas that arrive via
                # the agent event channel (OpenClaw >= 2026.4 routes streaming
                # content through `event:agent` with stream="assistant"; the
                # final `event:chat` state=final arrives with an empty message
                # and is now just a completion signal).
                agent_assistant_accum: str = ""
                # True when tool activity arrived after accumulated assistant
                # text. The next assistant delta is a NEW assistant message,
                # not a continuation of the pre-tool narration. Only that
                # terminal segment is returned to Chat (the transcript keeps
                # both messages). This prevents a toolUse assistant block and
                # the final stop block being concatenated into one reply.
                #
                # EVERY path that promotes the accumulator into the reply must
                # check this, not just the success path. While it is set, the
                # accumulator holds text the model wrote BEFORE a tool call —
                # scratchpad by definition, never an answer. The abort and
                # deadline fallbacks below promoted it unconditionally, so a
                # turn that died on a tool shipped exactly the narration the
                # final-event handler suppresses ("Here's how far I got: Now
                # run the batchUpdate."). Covered by test_reply_replay.py.
                assistant_boundary_pending: bool = False
                # Allow recv() to sit idle for up to 60s between events
                # without raising — long tool calls (web_fetch, model
                # inference on a big prompt) produce gaps with no stream
                # traffic. Was inheriting the 120s connect timeout from
                # create_connection which, combined with the old 120s
                # outer deadline, meant any idle >120s killed the turn
                # with the scratchpad as the final reply.
                ws.settimeout(60)
                while time.time() < deadline:
                    try:
                        raw = ws.recv()
                    except websocket.WebSocketTimeoutException:
                        # Idle gap, not a failure — outer deadline still
                        # governs. Fall through and let the while loop
                        # re-check time.time().
                        continue
                    msg = json.loads(raw)
                    mtype = msg.get("type")
                    mevent = msg.get("event") if mtype == "event" else None
                    key = f"{mtype}:{mevent}" if mevent else str(mtype)
                    event_counts[key] = event_counts.get(key, 0) + 1
                    if len(first_event_types) < 12:
                        first_event_types.append(key)
                    if len(raw_event_samples) < 3:
                        raw_event_samples.append(raw[:600] if isinstance(raw, str) else str(raw)[:600])

                    if mtype == "event" and mevent == "agent":
                        # DIAGNOSTIC (remove after schema discovery): log the
                        # first occurrence of each unique `stream` value with
                        # a payload sample so we can see what OpenClaw
                        # actually emits for model id / token usage / tool
                        # calls. The speculative field-name extraction below
                        # produced model=unknown + 0 tool_calls in initial
                        # runs (2026-05-28).
                        _stream_val = (msg.get("payload", {}) or {}).get("stream")
                        if isinstance(_stream_val, str):
                            _diag_key = f"_seen_stream::{_stream_val}"
                            if _diag_key not in event_counts:
                                event_counts[_diag_key] = 1
                                logger.info(
                                    "openclaw_event_sample stream=%s payload=%s",
                                    _stream_val,
                                    json.dumps(msg.get("payload", {}))[:1500],
                                )
                        # Agent events carry streaming content per OpenClaw's
                        # AgentEventSchema: {runId, seq, stream, ts, data}.
                        # We extract:
                        #   stream="assistant" → accumulate the user-visible
                        #     reply (drops markdown formatting later via
                        #     chat_format).
                        #   stream="thinking" → drop (reasoning isn't shown
                        #     to the user and isn't useful for telemetry).
                        #   stream="tool_call" / stream="tool_result" →
                        #     record into tool_calls for the Conversations
                        #     dashboard tab.
                        # Also opportunistically capture `model` whenever
                        # the harness reports it on any event so we can
                        # surface the real model id in agent_messages.
                        agent_payload = msg.get("payload", {})
                        stream = agent_payload.get("stream")
                        data = agent_payload.get("data", {})
                        # Lifecycle events carry sessionId/agentId at the
                        # payload top level (streaming events don't) — capture
                        # them wherever they appear so the post-turn transcript
                        # read can find the right file.
                        _sid = agent_payload.get("sessionId")
                        if isinstance(_sid, str) and _sid:
                            observed_session_uuid = _sid
                        _aid = agent_payload.get("agentId")
                        if isinstance(_aid, str) and _aid:
                            observed_agent_id = _aid
                        if isinstance(data, dict):
                            model_hint = data.get("model") or data.get("modelId")
                            if isinstance(model_hint, str) and model_hint:
                                observed_model = model_hint
                            # Token usage may appear on a 'usage' field on
                            # the final assistant event in newer builds.
                            usage = data.get("usage")
                            if isinstance(usage, dict):
                                ti = usage.get("input_tokens") or usage.get("prompt_tokens")
                                to = usage.get("output_tokens") or usage.get("completion_tokens")
                                if isinstance(ti, int):
                                    tokens_in = max(tokens_in, ti)
                                if isinstance(to, int):
                                    tokens_out = max(tokens_out, to)
                        if stream == "lifecycle" and isinstance(data, dict):
                            phase = data.get("phase")
                            lifecycle_error = data.get("error")
                            if (
                                phase in {"error", "finishing"}
                                and isinstance(lifecycle_error, str)
                                and lifecycle_error.strip()
                            ):
                                last_lifecycle_error = lifecycle_error.strip()
                        if stream == "assistant" and isinstance(data, dict):
                            # OpenClaw protocol v4 streams assistant text as
                            # `deltaText` (the incremental piece) alongside
                            # `message` (the CUMULATIVE snapshot); `replace=true`
                            # means deltaText replaces the buffer rather than
                            # appends. Protocol v3 used `delta`/`text` for the
                            # increment. Accumulate ONLY an incremental field;
                            # treat `message` as a whole-value snapshot (assign,
                            # never +=) — summing a cumulative field double-counts
                            # and garbles the reply ("H"+"He"+"Hel"…). The agent
                            # event payload is logged by the diagnostic above on
                            # first occurrence, so the live v4 shape is verifiable.
                            replace = data.get("replace") is True
                            increment = (
                                data.get("deltaText")
                                or data.get("delta")
                                or data.get("text")
                                or self._extract_text(data.get("content"))
                            )
                            cumulative = self._extract_text(data.get("message"))
                            if isinstance(increment, str) and increment:
                                agent_assistant_accum = self._accumulate_assistant(
                                    agent_assistant_accum,
                                    increment,
                                    replace,
                                    assistant_boundary_pending,
                                )
                                assistant_boundary_pending = False
                            elif isinstance(cumulative, str) and cumulative:
                                agent_assistant_accum = cumulative
                                assistant_boundary_pending = False
                        elif stream in ("item", "command_output"):
                            # Newer OpenClaw builds report tool activity as
                            # `item`/`command_output` streams. Tool activity
                            # after accumulated text means the next assistant
                            # delta starts a NEW assistant segment.
                            is_tool_activity = self._is_tool_activity_stream(
                                stream,
                                data,
                            )
                            if (
                                is_tool_activity
                                and (agent_assistant_accum or response_text)
                            ):
                                assistant_boundary_pending = True
                                response_text = ""
                            # Native-tool mode (#1138 r12+) reports tool
                            # execution ONLY here — record it so telemetry's
                            # tool_calls and the empty-turn nudge below see
                            # native-mode activity (the legacy tool_call/
                            # tool_result streams stay handled underneath).
                            if stream == "item" and isinstance(data, dict)                                     and data.get("kind") == "tool":
                                self._record_item_tool_event(
                                    data, tool_starts, tool_calls
                                )
                        elif stream == "tool_call" and isinstance(data, dict):
                            # Same boundary rule for protocol-v3 tool events.
                            if agent_assistant_accum or response_text:
                                assistant_boundary_pending = True
                                response_text = ""
                            tool_id = (
                                data.get("id")
                                or data.get("toolCallId")
                                or data.get("callId")
                                or str(uuid.uuid4())
                            )
                            tool_starts[tool_id] = {
                                "name": data.get("name") or data.get("tool") or "unknown",
                                "args": data.get("arguments") or data.get("args") or data.get("input"),
                                "started_at": time.time(),
                            }
                        elif stream == "tool_result" and isinstance(data, dict):
                            if agent_assistant_accum or response_text:
                                assistant_boundary_pending = True
                                response_text = ""
                            tool_id = (
                                data.get("id")
                                or data.get("toolCallId")
                                or data.get("callId")
                                or ""
                            )
                            start = tool_starts.pop(tool_id, None)
                            now = time.time()
                            started_at = start["started_at"] if start else now
                            entry = {
                                "name": (start or {}).get("name")
                                or data.get("name")
                                or "unknown",
                                "args": (start or {}).get("args"),
                                "result": data.get("result")
                                or data.get("output")
                                or data.get("content"),
                                # Normalized to the same success/error vocabulary
                                # the item path uses: a raw wire status like
                                # "completed" would otherwise flow straight into
                                # telemetry and the failed-turn summary, which
                                # gate on these exact values.
                                "status": _normalize_tool_status(
                                    data.get("status"), data.get("error")
                                ),
                                "error_text": (
                                    str(data.get("error"))[:2000]
                                    if data.get("error") else None
                                ),
                                "duration_ms": int(max(0, (now - started_at) * 1000)),
                                "started_at": datetime.fromtimestamp(
                                    started_at, tz=timezone.utc
                                ).isoformat(),
                                "finished_at": datetime.fromtimestamp(
                                    now, tz=timezone.utc
                                ).isoformat(),
                            }
                            tool_calls.append(entry)

                    elif mtype == "event" and mevent == "chat":
                        payload = msg.get("payload", {})
                        state = payload.get("state")
                        last_state = state
                        event_message = payload.get("message")
                        content = event_message.get("content") if isinstance(event_message, dict) else None
                        text = self._extract_text(content) or self._extract_text(event_message)
                        if text and not last_payload_sample:
                            last_payload_sample = text[:300]

                        if state == "delta":
                            if text:
                                response_text = text

                        elif state == "final":
                            if text:
                                response_text = text
                            # If chat-channel final arrived empty but we
                            # accumulated content via event:agent, fall back
                            # to the accumulator. Preserves content with
                            # newer OpenClaw builds without regressing older
                            # ones.
                            if (
                                not response_text
                                and agent_assistant_accum
                                and not assistant_boundary_pending
                            ):
                                response_text = agent_assistant_accum
                            got_final = True
                            break

                        elif state == "error":
                            err_msg = payload.get("errorMessage", "unknown")
                            err_class = _classify_chat_error(str(err_msg))
                            elapsed_s = max(
                                0, int(time.time() - chat_send_at)
                            )
                            run_id = payload.get("runId")
                            event_sequence = payload.get("seq")
                            visible_response = (
                                response_text or agent_assistant_accum
                            )
                            failure_context = {
                                "phase": "chat_event_error",
                                "last_state": last_state,
                                "elapsed_s": elapsed_s,
                                "deadline_s": deadline_s,
                                "response_chars": len(visible_response),
                                "tool_call_count": len(tool_calls),
                                "active_tool_count": len(tool_starts),
                                "event_counts": event_counts,
                                "first_events": first_event_types,
                            }
                            if isinstance(run_id, str) and run_id:
                                failure_context["run_id"] = run_id
                            if isinstance(event_sequence, int):
                                failure_context["event_sequence"] = (
                                    event_sequence
                                )
                            logger.error(
                                "chat event error: class=%s run_id=%s seq=%s "
                                "response_chars=%d tool_calls=%d "
                                "active_tools=%d elapsed_s=%d deadline_s=%d "
                                "event_counts=%s error=%s",
                                err_class,
                                run_id or "unknown",
                                event_sequence
                                if isinstance(event_sequence, int)
                                else "unknown",
                                len(visible_response),
                                len(tool_calls),
                                len(tool_starts),
                                elapsed_s,
                                deadline_s,
                                json.dumps(
                                    event_counts, separators=(",", ":")
                                ),
                                err_msg,
                            )
                            # Previously returned silently — no failure signal.
                            # This is where OpenClaw's "reply session
                            # initialization conflicted" surfaces, so recording
                            # it is what makes the session-conflict class of
                            # failure visible in agent_failures / the alarm.
                            # Context overflow gets its own class so the caller
                            # can recover it (fresh session) instead of
                            # treating it as a crash. A replay-unsafe incomplete
                            # tool turn is also distinct, but deliberately stays
                            # fail-closed downstream: the upgraded OpenClaw host
                            # already attempted the only safe, tools-disabled
                            # finalization. See _classify_chat_error.
                            record_failure(
                                source="harness",
                                severity="error",
                                error_class=err_class,
                                error_message=str(err_msg),
                                session_id=session_id,
                                model=observed_model or model_override,
                                context=failure_context,
                            )
                            # Never post the accumulated scratchpad narration
                            # as if it were the answer — frame it as a failed
                            # partial (issue #1138 F4).
                            err_text = _frame_failed_partial(
                                _format_for_chat(visible_response)
                                if visible_response
                                else "",
                                tool_calls,
                                tool_starts,
                            )
                            # An errored turn can still have burned tokens
                            # before it failed — bill them rather than
                            # reporting a free turn.
                            err_usage = self._read_turn_usage(
                                observed_session_uuid, observed_agent_id,
                                int(chat_send_at * 1000),
                            )
                            if err_usage["model_calls"] > 0:
                                tokens_in = err_usage["input"]
                                tokens_out = err_usage["output"]
                                cache_read = err_usage["cache_read"]
                                cache_write = err_usage["cache_write"]
                            return TurnResult(
                                text=err_text,
                                model=observed_model,
                                tokens_in=tokens_in,
                                tokens_out=tokens_out,
                                cache_read=cache_read,
                                cache_write=cache_write,
                                usage_capture_complete=bool(
                                    err_usage.get("capture_complete")
                                ),
                                latency_ms=int((time.time() - chat_send_at) * 1000),
                                messages=messages_log,
                                tool_calls=tool_calls,
                                tools_in_flight=len(tool_starts),
                                failed=True,
                                error_class=err_class,
                            )

                        elif state == "aborted":
                            chat_aborted = True
                            stop_reason = payload.get("stopReason")
                            if isinstance(stop_reason, str) and stop_reason:
                                abort_stop_reason = stop_reason
                            logger.warning("chat aborted: payload=%s", json.dumps(payload)[:500])
                            break

                    elif mtype == "event" and isinstance(mevent, str) and mevent.startswith("question."):
                        # The agent asked the user a clarifying question.
                        #
                        # Our transport is Google Chat, which is strictly
                        # turn-based: there is no channel to answer a question
                        # WITHIN the turn that asked it. Before 2026-08-05 this
                        # event was counted and then dropped on the floor, so
                        # the gateway blocked waiting for an answer that could
                        # never arrive and the loop spun to the full deadline.
                        # That was the single largest failure source in prod —
                        # 25 turns across 15 users in three days, every one
                        # burning ~9.5 minutes of compute to deliver nothing
                        # (100% of ChatDeadlineExpired* rows carried this event;
                        # no other failure class did).
                        #
                        # Treat it as terminal: surface the question as the
                        # turn's reply so the user can simply answer in their
                        # next message. Matched on the `question.` prefix rather
                        # than the exact `question.requested` so a renamed or
                        # additional question event cannot silently reintroduce
                        # the hang.
                        q_payload = msg.get("payload", {}) or {}
                        q_data = q_payload.get("data")
                        if not isinstance(q_data, dict):
                            q_data = {}
                        question_text = None
                        # The gateway's exact field name is not pinned by any
                        # contract we own, so probe the plausible carriers and
                        # fall back to a generic prompt rather than returning
                        # an empty turn.
                        for source in (q_payload, q_data):
                            for key in ("question", "text", "prompt", "message", "content"):
                                candidate = self._extract_text(source.get(key))
                                if candidate:
                                    question_text = candidate
                                    break
                            if question_text:
                                break
                        if not question_text:
                            question_text = (
                                "I need a bit more information to continue — "
                                "could you clarify what you'd like me to do?"
                            )
                            logger.warning(
                                "question event carried no recognizable text: "
                                "event=%s payload_keys=%s",
                                mevent,
                                sorted(q_payload.keys()),
                            )
                        # Keep any partial answer the agent already streamed, so
                        # work done before the question is not thrown away.
                        prefix = response_text or agent_assistant_accum or ""
                        response_text = (
                            f"{prefix}\n\n{question_text}".strip()
                            if prefix
                            else question_text
                        )
                        logger.info(
                            "question event resolved to a turn reply: event=%s "
                            "elapsed_s=%d had_partial=%s",
                            mevent,
                            max(0, int(time.time() - chat_send_at)),
                            bool(prefix),
                        )
                        got_final = True
                        break

                    elif mtype == "res" and msg.get("id") == chat_id:
                        # DIAGNOSTIC (remove after schema discovery): dump
                        # the final res payload so we can see if usage /
                        # model lives here vs on agent events.
                        if "_seen_chat_res" not in event_counts:
                            event_counts["_seen_chat_res"] = 1
                            logger.info(
                                "openclaw_chat_res_sample payload=%s",
                                json.dumps(msg.get("payload", {}))[:1500],
                            )
                        if not msg.get("ok"):
                            error = msg.get("error", {})
                            logger.error("chat.send error: %s", json.dumps(error)[:500])
                            # Previously returned silently — no failure signal.
                            record_failure(
                                source="harness",
                                severity="error",
                                error_class="OpenClawChatSendError",
                                error_message=json.dumps(error)[:2000],
                                session_id=session_id,
                                model=observed_model or model_override,
                                context={"phase": "chat_send_res"},
                            )
                            return TurnResult(
                                text="I encountered an error processing your message.",
                                model=observed_model,
                                latency_ms=int((time.time() - chat_send_at) * 1000),
                                messages=messages_log,
                                tool_calls=tool_calls,
                                tools_in_flight=len(tool_starts),
                                failed=True,
                                error_class="OpenClawChatSendError",
                            )
                        res_payload = msg.get("payload", {})
                        # Final res may carry the authoritative usage object.
                        usage = res_payload.get("usage")
                        if isinstance(usage, dict):
                            ti = usage.get("input_tokens") or usage.get("prompt_tokens")
                            to = usage.get("output_tokens") or usage.get("completion_tokens")
                            if isinstance(ti, int):
                                tokens_in = max(tokens_in, ti)
                            if isinstance(to, int):
                                tokens_out = max(tokens_out, to)
                        model_field = res_payload.get("model") or res_payload.get("modelId")
                        if isinstance(model_field, str) and model_field:
                            observed_model = model_field
                        status = res_payload.get("status")
                        if status in {"started", "accepted"}:
                            continue
                        if status in {"final", "done"}:
                            if (
                                not response_text
                                and agent_assistant_accum
                                and not assistant_boundary_pending
                            ):
                                response_text = agent_assistant_accum
                            got_final = True
                            break

            finally:
                ws.close()

        except Exception as exc:
            logger.error("WebSocket error: %s", str(exc)[:500])
            record_failure(
                source="harness",
                severity="error",
                exc=exc,
                session_id=session_id,
                model=model_override,
                context={"phase": "websocket"},
            )
            return TurnResult(
                text="I'm temporarily unable to respond. The agent process may be restarting.",
                model=observed_model,
                messages=messages_log,
                tool_calls=tool_calls,
                tools_in_flight=len(tool_starts),
                failed=True,
                error_class="WebSocketError",
            )

        latency_ms = int((time.time() - chat_send_at) * 1000)

        # Real token usage for this turn (issue #1384 follow-up). Deliberately
        # read HERE — after the event loop, before the empty-turn nudge below
        # recurses — so the nudge leg's transcript window starts after this read
        # and the two legs sum instead of double-counting. The WS-scraped
        # tokens_in/tokens_out above stay as the fallback for a harness that
        # does surface usage on its events; OpenClaw does not.
        turn_usage = self._read_turn_usage(
            observed_session_uuid, observed_agent_id, int(chat_send_at * 1000),
        )
        if turn_usage["model_calls"] > 0:
            tokens_in = turn_usage["input"]
            tokens_out = turn_usage["output"]
            cache_read = turn_usage["cache_read"]
            cache_write = turn_usage["cache_write"]

        def _result(
            text: str,
            *,
            failed: bool = False,
            error_class: Optional[str] = None,
            nudged: bool = False,
        ) -> TurnResult:
            assistant = text or ""
            log = list(messages_log)
            if assistant:
                log.append({"role": "assistant", "content": assistant})
            return TurnResult(
                text=assistant,
                model=observed_model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cache_read=cache_read,
                cache_write=cache_write,
                usage_capture_complete=bool(
                    turn_usage.get("capture_complete")
                ),
                latency_ms=latency_ms,
                messages=log,
                tool_calls=tool_calls,
                tools_in_flight=len(tool_starts),
                failed=failed,
                error_class=error_class,
                nudged=nudged,
            )

        # A lifecycle error is terminal unless OpenClaw subsequently emits a
        # successful final event. Usually chat follows it with `aborted`, but
        # preserve the real cause even if that channel event never arrives and
        # the receive loop instead runs to its deadline.
        if chat_aborted or (not got_final and last_lifecycle_error):
            if (
                not response_text
                and agent_assistant_accum
                and not assistant_boundary_pending
            ):
                response_text = agent_assistant_accum
            error_message = (
                last_lifecycle_error
                or f"chat aborted (stopReason={abort_stop_reason or 'unknown'})"
            )
            error_class = (
                _classify_chat_error(last_lifecycle_error)
                if last_lifecycle_error
                else "OpenClawChatAborted"
            )
            terminal_phase = (
                "chat_aborted" if chat_aborted else "lifecycle_error"
            )
            logger.error(
                "chat failed before final: phase=%s error_class=%s "
                "stop_reason=%s elapsed_s=%d deadline_s=%d event_counts=%s",
                terminal_phase,
                error_class,
                abort_stop_reason or "unknown",
                latency_ms // 1000,
                deadline_s,
                json.dumps(event_counts),
            )
            record_failure(
                source="harness",
                severity="error",
                error_class=error_class,
                error_message=error_message,
                session_id=session_id,
                model=observed_model or model_override,
                context={
                    "phase": terminal_phase,
                    "last_state": last_state,
                    "stop_reason": abort_stop_reason,
                    "elapsed_s": latency_ms // 1000,
                    "deadline_s": deadline_s,
                    "event_counts": event_counts,
                    "first_events": first_event_types,
                },
            )
            return _result(
                _frame_failed_partial(
                    _format_for_chat(response_text.strip()), tool_calls, tool_starts
                ),
                failed=True,
                error_class=error_class,
            )

        if not got_final:
            if (
                not response_text
                and agent_assistant_accum
                and not assistant_boundary_pending
            ):
                response_text = agent_assistant_accum
            logger.error(
                "chat deadline expired: partial_len=%d accum_len=%d "
                "last_state=%s event_counts=%s first_events=%s "
                "text_head=%r raw_sample=%r",
                len(response_text),
                len(agent_assistant_accum),
                last_state,
                json.dumps(event_counts),
                first_event_types,
                response_text[:400],
                raw_event_samples[0] if raw_event_samples else "",
            )
            if response_text:
                record_failure(
                    source="harness",
                    severity="warn",
                    error_class="ChatDeadlineExpiredPartial",
                    error_message=(
                        f"chat deadline expired with partial response "
                        f"(last_state={last_state})"
                    ),
                    session_id=session_id,
                    model=observed_model or model_override,
                    context={
                        "phase": "deadline",
                        "last_state": last_state,
                        "elapsed_s": latency_ms // 1000,
                        "deadline_s": deadline_s,
                        "event_counts": event_counts,
                        "first_events": first_event_types,
                    },
                )
                # A partial that never reached a final event is still a
                # failed turn — frame it so it doesn't read as a finished
                # answer (issue #1138 F4).
                return _result(
                    _frame_failed_partial(
                        _format_for_chat(response_text.strip()),
                        tool_calls,
                        tool_starts,
                    ),
                    failed=True,
                    error_class="ChatDeadlineExpiredPartial",
                )
            record_failure(
                source="harness",
                severity="error",
                error_class="ChatDeadlineExpired",
                error_message=(
                    f"chat deadline expired without final event "
                    f"(last_state={last_state})"
                ),
                session_id=session_id,
                model=observed_model or model_override,
                context={
                    "phase": "deadline",
                    "last_state": last_state,
                    "elapsed_s": latency_ms // 1000,
                    "deadline_s": deadline_s,
                    "event_counts": event_counts,
                    "first_events": first_event_types,
                },
            )
            return _result(
                "I wasn't able to finish responding in time — the agent "
                "stalled. Please try again in a moment.",
                failed=True,
                error_class="ChatDeadlineExpired",
            )

        logger.info(
            "chat turn ok: resp_len=%d last_state=%s event_counts=%s "
            "model=%s tokens_in=%d tokens_out=%d cache_read=%d cache_write=%d "
            "latency_ms=%d tool_calls=%d transcript_model_calls=%d",
            len(response_text),
            last_state,
            json.dumps(event_counts),
            observed_model or "unknown",
            tokens_in,
            tokens_out,
            cache_read,
            cache_write,
            latency_ms,
            len(tool_calls),
            # Exact model round-trip count observed in the transcript. Logged
            # for cross-checking the (heuristic) len(tool_calls)+1 that still
            # feeds agent_messages.model_call_count — not wired in, so the
            # existing metric's history stays comparable.
            turn_usage["model_calls"],
        )

        if response_text.strip():
            return _result(_format_for_chat(response_text.strip()))
        # A start with no terminal event is replay-unsafe: the call may have
        # already created the Doc, and tool_starts is emptied by pop() the
        # moment a terminal event lands, so a non-empty tool_starts means
        # genuinely in flight. The no-tools wording does not forbid re-running
        # tools, so nudging here could execute the side effect twice — the same
        # hazard _should_retry_upstream refuses on tools_in_flight. Before
        # 2026-08-09 this case got no nudge either (tool_calls was empty), so
        # skipping preserves the old behavior exactly rather than adding a new
        # risk. Tool work that DID complete keeps its original nudge, whose
        # wording already forbids re-running tools.
        #
        # The `has_tools or` short-circuit is deliberate, and asymmetric with
        # _should_retry_upstream on purpose. A turn can hold BOTH a completed
        # tool call and a second one still in flight; that shape takes the
        # tools branch and nudges, guarded by EMPTY_TURN_NUDGE's "Do not
        # re-run any tools" wording rather than by this gate.
        # _should_retry_upstream is stricter because it replays the USER's
        # original message verbatim — it has no wording of its own to lean
        # on. The nudge sends a prompt this file controls, so the wording IS
        # the guard, and only the no-tools variant (which cannot carry that
        # sentence without asserting work that never happened) needs the hard
        # gate. Tightening this to `not tools_in_flight_now` would also
        # withdraw the nudge from mixed-shape turns that have had it since
        # long before 2026-08-09 — out of scope for this fix. Pinned by
        # test_completed_tool_plus_in_flight_still_gets_tools_nudge.
        has_tools = bool(tool_calls)
        tools_in_flight_now = bool(tool_starts)
        should_nudge = has_tools or not tools_in_flight_now
        if not _is_nudge and should_nudge:
            # The turn produced no user-visible reply — nudge once instead of
            # sending the canned fallback (#1138, observed live on r12).
            # Recursion is bounded by _is_nudge; a short deadline is plenty at
            # direct-Mantle serving speeds.
            #
            # This fired only when tool_calls ran until 2026-08-09, on the
            # theory that a turn with no tool work had nothing to summarize.
            # Prod disagrees: of the EmptyAgentResponse rows since 2026-08-01,
            # every one reached last_state=final, and half of those recorded
            # first_events=["event:chat"] with no res/usage/lifecycle events at
            # all. Those turns never had a tool call, so they never got a
            # nudge — the user just got the canned fallback. They deserve the
            # same one-shot recovery, with wording that does not assert tool
            # work that did not happen (that would invite a SOUL rule 4
            # violation: never fabricate outcomes).
            logger.warning(
                "empty final after %d tool calls — sending one nudge "
                "(variant=%s)",
                len(tool_calls),
                "tools" if has_tools else "no-tools",
            )
            # Iteration telemetry (issue #1161): a nudge fired this turn.
            # Emit a CloudWatch metric (best-effort) so nudge-fire rate is
            # trendable in the AgentCore container log group, which has a
            # runtime-generated suffix a MetricFilter can't attach to.
            # Deliberately the same metric name for both variants so the
            # existing nudge-fire trend stays comparable across this change.
            emit_agent_metric("AgentNudgeFired")
            nudge_prompt = (
                self.EMPTY_TURN_NUDGE
                if has_tools
                else self.EMPTY_TURN_NUDGE_NO_TOOLS
            )
            nudged = self.process(
                nudge_prompt,
                session_id,
                model_override,
                deadline_s=180,
                _is_nudge=True,
            )
            # A nudge leg that ALSO ends empty does not come back with empty
            # text — it falls through to the canned fallback below and returns
            # that, which is non-empty. Testing text alone therefore treats
            # every failed nudge as a success, returns early, and skips the
            # outer failure row entirely. Check the error class too, so a nudge
            # that did not actually recover falls through to be recorded once,
            # by this leg, with accurate nudge_* telemetry.
            #
            # Named for what it literally tests, not "recovered": a nudge leg
            # that failed some OTHER way (a ChatDeadlineExpired partial, say)
            # still returns text and still takes this branch. That is correct
            # — the nested leg already recorded its own failure, and
            # failed/error_class propagate through the TurnResult below — but
            # only because this is a "did it come back with something to show
            # the user" test, not a success test.
            nudge_returned_text = bool(nudged.text.strip()) and (
                nudged.error_class != "EmptyAgentResponse"
            )
            if nudge_returned_text:
                merged_tools = tool_calls + nudged.tool_calls
                return TurnResult(
                    text=nudged.text,
                    model=nudged.model or observed_model,
                    # Safe to sum: this leg's transcript window was read before
                    # the nudge was sent, so the nudge's own window starts after
                    # it and the two never cover the same model call.
                    tokens_in=tokens_in + nudged.tokens_in,
                    tokens_out=tokens_out + nudged.tokens_out,
                    cache_read=cache_read + nudged.cache_read,
                    cache_write=cache_write + nudged.cache_write,
                    usage_capture_complete=(
                        bool(turn_usage.get("capture_complete"))
                        and nudged.usage_capture_complete
                    ),
                    latency_ms=int((time.time() - chat_send_at) * 1000),
                    messages=messages_log + nudged.messages,
                    tool_calls=merged_tools,
                    tools_in_flight=len(tool_starts) + nudged.tools_in_flight,
                    failed=nudged.failed,
                    error_class=nudged.error_class,
                    # The nudge fired and recovered a reply — record it so the
                    # dashboard counts this turn in the nudge-fire rate even
                    # though it wrote no agent_failures row.
                    nudged=True,
                )
        if _is_nudge:
            # The nudge leg is an internal recovery attempt, not a user turn.
            # Recording here would write a SECOND row for the same turn, and it
            # would be the misleading one: _is_nudge makes nudge_attempted read
            # false on the very row that proves a nudge happened. Stay silent
            # and let the outer leg record the single accurate row.
            return _result(
                "I processed your message but had no response.",
                failed=True,
                error_class="EmptyAgentResponse",
                nudged=False,
            )
        record_failure(
            source="harness",
            severity="empty_response",
            error_class="EmptyAgentResponse",
            error_message=(
                "Agent reached final state but produced no user-visible text"
            ),
            session_id=session_id,
            model=observed_model or model_override,
            context={
                "last_state": last_state,
                "event_counts": event_counts,
                "first_events": first_event_types,
                # Reaching here means no nudge rescued the turn. Record whether
                # one was even attempted, and which wording — without this, a
                # row that never got a nudge is indistinguishable from one
                # where the nudge fired and the model stayed silent — exactly
                # the ambiguity that made these rows hard to read.
                "nudge_attempted": should_nudge,
                "nudge_variant": (
                    ("tools" if has_tools else "no-tools")
                    if should_nudge
                    else None
                ),
                # Set when the nudge was skipped because a tool call was still
                # in flight and replaying it could double a side effect.
                "nudge_skipped_tools_in_flight": (
                    tools_in_flight_now and not should_nudge
                ),
            },
        )
        # Only reachable on the outer leg (the _is_nudge branch returned
        # above), so nudged mirrors should_nudge: a nudge fired unless it was
        # skipped for a tool still in flight.
        return _result(
            "I processed your message but had no response.",
            failed=True,
            error_class="EmptyAgentResponse",
            nudged=should_nudge,
        )

    @staticmethod
    def _record_item_tool_event(data, tool_starts, tool_calls) -> None:
        """Track a native-mode tool item (stream="item", kind="tool").

        phase="start" registers the call; a later phase ("end"/"error"/
        anything terminal with a status) completes it into tool_calls. The
        item stream is the ONLY place beta.2 reports tool execution when
        toolSearch/code-mode is off, so without this the Conversations tab
        showed zero tool calls and the empty-turn nudge couldn't tell a
        silent WORKING turn from a truly idle one.
        """
        item_id = data.get("itemId") or data.get("toolCallId") or ""
        phase = data.get("phase")
        if phase == "start":
            tool_starts[item_id] = {
                "name": data.get("name") or data.get("title") or "unknown",
                "args": data.get("meta"),
                "started_at": time.time(),
            }
            return
        start = tool_starts.pop(item_id, None)
        now = time.time()
        started_at = start["started_at"] if start else now
        tool_calls.append({
            "name": (start or {}).get("name") or data.get("name") or "unknown",
            "args": (start or {}).get("args"),
            "result": data.get("output") or data.get("result"),
            "status": "error" if (data.get("status") in ("error", "failed")) else "success",
            "error_text": (
                str(data.get("error"))[:2000] if data.get("error") else None
            ),
            "duration_ms": int(max(0, (now - started_at) * 1000)),
            "started_at": datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat(),
            "finished_at": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        })

    # Sent as a one-shot follow-up when a turn completes tool work but ends
    # with no user-visible text (observed live on r12: the model executed
    # every grant, then a provider timeout ate the closing message and the
    # user got the canned empty-response fallback). One nudge only — if the
    # model stays silent twice, the canned fallback stands.
    EMPTY_TURN_NUDGE = (
        "[system-nudge] Your previous turn finished tool work but sent the "
        "user NO reply — they saw nothing. Send the user-facing summary of "
        "what you just did (and its outcome) now, as plain text. Do not "
        "re-run any tools unless something genuinely failed."
    )

    # Same one-shot recovery for a turn that ended empty having run NO tools.
    # Worded so it cannot be read as "summarize your work": there was none, and
    # inviting a summary here would be inviting fabrication (SOUL rule 4).
    EMPTY_TURN_NUDGE_NO_TOOLS = (
        "[system-nudge] Your previous turn ended without sending the user any "
        "reply — they saw nothing at all. Answer their most recent message "
        "now, as plain text. If you cannot answer it, say so plainly and say "
        "what you need in order to. Do not describe any work or tool call you "
        "did not actually perform."
    )

    @staticmethod
    def _resolve_deadline_s(override) -> int:
        """Resolve the turn deadline in seconds.

        `override` is the payload-supplied deadline from the async-job runner
        (#1138): the promoted job leg holds the SSE stream for up to 2 hours,
        so the override clamps to [60, 7200] (ceiling approved 2026-07-07).
        Interactive turns send no override and keep the env-var/default path
        clamped to [60, 550]. This leaves at least 350 seconds of the Router
        Lambda's 15-minute ceiling for cold start, a bounded proxy restart,
        final workspace persistence, and response delivery. Garbage values
        degrade to the 550s default, never raise.
        """
        default_deadline_s = 550
        if override is not None:
            try:
                return max(60, min(7200, int(override)))
            except (TypeError, ValueError):
                return default_deadline_s
        try:
            value = int(os.environ.get(
                "OPENCLAW_CHAT_DEADLINE_S",
                str(default_deadline_s),
            ))
        except ValueError:
            value = default_deadline_s
        return max(60, min(550, value))

    @staticmethod
    def _accumulate_assistant(
        accum: str,
        increment: str,
        replace: bool,
        boundary_pending: bool,
    ) -> str:
        """Append a streamed assistant increment to the turn accumulator.

        `replace` resets the buffer (protocol v4 replace-mode delta).
        `boundary_pending` means tool activity separated this increment from
        the previously accumulated text — i.e. OpenClaw started a NEW
        assistant message. The earlier text was pre-tool narration, so replace
        it and return only the terminal assistant block to Chat.
        Increments within one segment must never get separators; the caller
        only sets `boundary_pending` on tool events.
        """
        if replace:
            return increment
        if boundary_pending:
            return increment
        return accum + increment

    @staticmethod
    def _is_tool_activity_stream(stream: object, data: object) -> bool:
        """Return whether an event separates assistant messages around a tool.

        ``item`` is a shared progress lane in OpenClaw: it carries executable
        tool-like work, but also commentary and lifecycle plumbing. Treating
        every item as a tool boundary can discard an already-complete terminal
        answer when a non-tool progress item arrives immediately before the
        final chat event.
        """
        if stream == "command_output":
            return True
        if stream != "item" or not isinstance(data, dict):
            return False
        return data.get("kind") in {
            "tool",
            "command",
            "command_output",
            "patch",
            "search",
            "api",
        }

    @staticmethod
    def _extract_text(content) -> str:
        """Recursively extract text from OpenClaw content blocks."""
        if isinstance(content, str):
            try:
                parsed = json.loads(content)
                return OpenClawAdapter._extract_text(parsed)
            except (json.JSONDecodeError, TypeError):
                return content
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    parts.append(block)
            # Join DISTINCT text blocks with a blank line. The model emits a
            # short narration text block before each tool call, so a single
            # assistant message often carries several text blocks interleaved
            # with tool_use blocks. Concatenating them with no separator
            # produced runs like "...in Plaud.Good, done. Let's read the
            # file.Now getting..." (issue #1138 F4). Blank-line join keeps each
            # block readable; empties are dropped so we never emit a leading or
            # trailing separator.
            return "\n\n".join(p for p in parts if p and p.strip())
        return str(content) if content else ""

    def health(self) -> bool:
        """Check if the OpenClaw gateway is responsive."""
        return self._ready

    def shutdown(self) -> None:
        """Stop the gateway and every tool/background child in its process group."""
        self._ready = False
        if self._process:
            logger.info("Stopping OpenClaw gateway")
            group_id = self._process_group_id
            if isinstance(group_id, int) and group_id > 1:
                try:
                    os.killpg(group_id, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    if self._process.poll() is None:
                        self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                # The group leader can exit while a tool/background child
                # ignores SIGTERM. Always kill the whole group after the
                # bounded grace; ESRCH proves it was already gone.
                try:
                    os.killpg(group_id, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if self._process.poll() is None:
                    self._process.wait(timeout=10)
                _wait_for_process_group_quiescence(group_id)
            elif self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=10)
        self._process = None
        self._process_group_id = None
