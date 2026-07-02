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
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from agent_failures import record_failure
from chat_format import markdown_to_chat

logger = logging.getLogger("harness_adapter")


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
    latency_ms: int = 0
    messages: List[Dict[str, Any]] = dataclasses.field(default_factory=list)
    tool_calls: List[Dict[str, Any]] = dataclasses.field(default_factory=list)
    # Set True when this turn is an error/degraded return (session conflict,
    # deadline, empty response, WS failure) rather than a real answer. The
    # wrapper forwards this to the router (metadata.failed) so a 0-token error
    # turn is no longer logged as a clean "Message processed" success.
    failed: bool = False
    error_class: Optional[str] = None


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


class HarnessAdapter(abc.ABC):
    """Abstract base class for agent harness adapters."""

    @abc.abstractmethod
    def process(
        self,
        message: str,
        session_id: str,
        model_override: Optional[str] = None,
    ) -> Union[str, TurnResult]:
        """Send a message to the harness and return either a plain string
        (legacy contract) or a TurnResult (preferred). Wrapper accepts
        both."""

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
    # Fixed gateway token passed via --token CLI flag. OpenClaw overwrites the
    # config file on startup (generating a new random token), so reading from
    # the config is unreliable. The --token CLI flag overrides the config value.
    GATEWAY_TOKEN = "psd-agent-internal-gateway-token"
    # client.id MUST be "openclaw-tui" — verified by reading OpenClaw source:
    # - "cli" passes auth but scopes are cleared (not an operator UI client)
    # - "openclaw-control-ui" triggers browser origin check (rejects non-browser)
    # - "openclaw-tui" passes isOperatorUiClient (scopes preserved) without
    #   triggering isBrowserOperatorUiClient (no origin check)
    # See: /app/dist/message-channel-CBqCPFa_.js lines 80-85
    CLIENT_INFO = {
        "id": "openclaw-tui",
        "mode": "backend",
        "version": "dev",
        "platform": "linux",
    }

    def __init__(self) -> None:
        self._gateway_port: int = 3100
        self._process: Optional[subprocess.Popen] = None
        self._ready: bool = False

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
                        "--token", self.GATEWAY_TOKEN,
                    ],
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                    env={
                        **os.environ,
                        "HOME": "/home/node",
                        "OPENCLAW_NO_RESPAWN": "1",
                    },
                )
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

    def process(
        self,
        message: str,
        session_id: str,
        model_override: Optional[str] = None,
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
        tokens_in = 0
        tokens_out = 0
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

        gateway_token = self.GATEWAY_TOKEN
        ws_url = f"ws://127.0.0.1:{self._gateway_port}"
        response_text = ""

        # Retry WebSocket connection up to 3 times — the gateway may still
        # be initializing WebSocket handling even after /health returns 200.
        ws = None
        last_error = None
        for attempt in range(3):
            try:
                ws = websocket.create_connection(ws_url, timeout=120)
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
                        # unchanged, and device auth is disabled in the gateway
                        # config (dangerouslyDisableDeviceAuth=true), so no
                        # `device` block is required.
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
                                logger.info(
                                    "tools.catalog ok: %s",
                                    json.dumps(tools)[:1500],
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
                # Deadline sizing: the enclosing budget stack is
                #   Router Lambda (15 min) > undici fetch (14 min) > us.
                # We leave a 1-minute margin under undici so we always
                # surface a real "stalled" log line rather than getting
                # killed mid-recv by an upstream timeout. Long research
                # turns legitimately take 5-10 minutes (web_fetch heavy
                # investigation), and the prior 120s ceiling was dumping
                # the model's scratchpad as the final reply while the
                # real answer continued to generate in the microVM after
                # the entrypoint had already returned. See #890 incident
                # logs 2026-04-22.
                #
                # OPENCLAW_CHAT_DEADLINE_S env override for escape hatch,
                # clamped to [60, 840] so a misconfig can't either starve
                # the turn or exceed the undici/Lambda ceilings.
                # 14 min — 30s under the cron Lambda's 14:30 AbortSignal so
                # the harness gets a chance to return whatever it has
                # accumulated before the client kills the connection.
                default_deadline_s = 840
                try:
                    deadline_s = int(os.environ.get(
                        "OPENCLAW_CHAT_DEADLINE_S",
                        str(default_deadline_s),
                    ))
                except ValueError:
                    deadline_s = default_deadline_s
                deadline_s = max(60, min(840, deadline_s))
                deadline = time.time() + deadline_s
                got_final = False
                event_counts: dict = {}
                first_event_types: list = []
                last_state: Optional[str] = None
                last_payload_sample: str = ""
                raw_event_samples: list = []
                # Accumulator for streaming assistant deltas that arrive via
                # the agent event channel (OpenClaw >= 2026.4 routes streaming
                # content through `event:agent` with stream="assistant"; the
                # final `event:chat` state=final arrives with an empty message
                # and is now just a completion signal).
                agent_assistant_accum: str = ""
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
                                agent_assistant_accum = (
                                    increment
                                    if replace
                                    else agent_assistant_accum + increment
                                )
                            elif isinstance(cumulative, str) and cumulative:
                                agent_assistant_accum = cumulative
                        elif stream == "tool_call" and isinstance(data, dict):
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
                                "status": data.get("status")
                                or ("error" if data.get("error") else "success"),
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
                            if not response_text and agent_assistant_accum:
                                response_text = agent_assistant_accum
                            got_final = True
                            break

                        elif state == "error":
                            err_msg = payload.get("errorMessage", "unknown")
                            logger.error(
                                "chat event error: %s | full_payload=%s",
                                err_msg,
                                json.dumps(payload)[:800],
                            )
                            # Previously returned silently — no failure signal.
                            # This is where OpenClaw's "reply session
                            # initialization conflicted" surfaces, so recording
                            # it is what makes the session-conflict class of
                            # failure visible in agent_failures / the alarm.
                            record_failure(
                                source="harness",
                                severity="error",
                                error_class="OpenClawChatError",
                                error_message=str(err_msg),
                                session_id=session_id,
                                model=observed_model or model_override,
                                context={
                                    "phase": "chat_event_error",
                                    "last_state": last_state,
                                },
                            )
                            err_text = (
                                _format_for_chat(response_text)
                                if response_text
                                else "I encountered an error processing your message."
                            )
                            return TurnResult(
                                text=err_text,
                                model=observed_model,
                                tokens_in=tokens_in,
                                tokens_out=tokens_out,
                                latency_ms=int((time.time() - chat_send_at) * 1000),
                                messages=messages_log,
                                tool_calls=tool_calls,
                                failed=True,
                                error_class="OpenClawChatError",
                            )

                        elif state == "aborted":
                            logger.warning("chat aborted: payload=%s", json.dumps(payload)[:500])
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
                            if not response_text and agent_assistant_accum:
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
                failed=True,
                error_class="WebSocketError",
            )

        latency_ms = int((time.time() - chat_send_at) * 1000)

        def _result(
            text: str,
            *,
            failed: bool = False,
            error_class: Optional[str] = None,
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
                latency_ms=latency_ms,
                messages=log,
                tool_calls=tool_calls,
                failed=failed,
                error_class=error_class,
            )

        if not got_final:
            if not response_text and agent_assistant_accum:
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
                        "event_counts": event_counts,
                        "first_events": first_event_types,
                    },
                )
                return _result(
                    _format_for_chat(response_text.strip()),
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
            "model=%s tokens_in=%d tokens_out=%d latency_ms=%d tool_calls=%d",
            len(response_text),
            last_state,
            json.dumps(event_counts),
            observed_model or "unknown",
            tokens_in,
            tokens_out,
            latency_ms,
            len(tool_calls),
        )

        if response_text.strip():
            return _result(_format_for_chat(response_text.strip()))
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
            },
        )
        return _result(
            "I processed your message but had no response.",
            failed=True,
            error_class="EmptyAgentResponse",
        )

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
            return "".join(parts)
        return str(content) if content else ""

    def health(self) -> bool:
        """Check if the OpenClaw gateway is responsive."""
        return self._ready

    def shutdown(self) -> None:
        """Stop the OpenClaw gateway process."""
        self._ready = False
        if self._process and self._process.poll() is None:
            logger.info("Stopping OpenClaw gateway")
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
