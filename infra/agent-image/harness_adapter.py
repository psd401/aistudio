"""
Harness Adapter Interface — Abstraction layer for agent harnesses.

The adapter pattern allows swapping OpenClaw for Hermes (or any other harness)
without changing the AgentCore wrapper. Each adapter implements the same interface.
"""

import abc
import json
import logging
import os
import subprocess
import sys
import time
import uuid
from typing import Optional

logger = logging.getLogger("harness_adapter")


class HarnessAdapter(abc.ABC):
    """Abstract base class for agent harness adapters."""

    @abc.abstractmethod
    def process(self, message: str, session_id: str, model_override: Optional[str] = None) -> str:
        """Send a message to the harness and return the response."""

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
                self._wait_for_ready(timeout=30)
                # Give the gateway time to fully initialize WebSocket handling
                time.sleep(3)

    def _wait_for_ready(self, timeout: int = 30) -> None:
        """Poll the gateway health endpoint until ready."""
        import urllib.request
        import urllib.error

        url = f"http://127.0.0.1:{self._gateway_port}/health"
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=2) as resp:
                    if resp.status == 200:
                        self._ready = True
                        logger.info("OpenClaw gateway is ready")
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(1)

        raise RuntimeError(
            f"OpenClaw gateway did not become ready within {timeout}s"
        )

    def process(self, message: str, session_id: str, model_override: Optional[str] = None) -> str:
        """Send a message to OpenClaw via WebSocket and return the response.

        Uses the native OpenClaw gateway WebSocket protocol:
        connect.challenge → connect (auth) → chat.send → collect chat events
        """
        if not self._ready:
            raise RuntimeError(
                "OpenClaw gateway is not ready — configure() with gateway_port "
                "must be called before process()"
            )

        try:
            import websocket  # websocket-client library
        except ImportError:
            logger.error("websocket-client not installed, falling back to error")
            return "Agent communication library not available. Please contact an administrator."

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
            return f"I'm temporarily unable to respond. Error: {str(last_error)[:100]}"

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
                        "minProtocol": 3,
                        "maxProtocol": 3,
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
                    return f"[WS_AUTH_FAIL] {json.dumps(connect_resp)[:800]}"

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
                deadline = time.time() + 120
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
                while time.time() < deadline:
                    raw = ws.recv()
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
                        # Agent events carry streaming content per OpenClaw's
                        # AgentEventSchema: {runId, seq, stream, ts, data}.
                        # stream="assistant" holds model output; stream=
                        # "thinking" is reasoning which we intentionally drop
                        # from user-facing replies. Tool events are ignored
                        # here — they surface via their own channel.
                        agent_payload = msg.get("payload", {})
                        stream = agent_payload.get("stream")
                        data = agent_payload.get("data", {})
                        if stream == "assistant" and isinstance(data, dict):
                            delta = (
                                data.get("delta")
                                or data.get("text")
                                or self._extract_text(data.get("content"))
                                or self._extract_text(data.get("message"))
                            )
                            if isinstance(delta, str) and delta:
                                agent_assistant_accum += delta

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
                            logger.error(
                                "chat event error: %s | full_payload=%s",
                                payload.get("errorMessage", "unknown"),
                                json.dumps(payload)[:800],
                            )
                            return response_text or "I encountered an error processing your message."

                        elif state == "aborted":
                            logger.warning("chat aborted: payload=%s", json.dumps(payload)[:500])
                            break

                    elif mtype == "res" and msg.get("id") == chat_id:
                        if not msg.get("ok"):
                            error = msg.get("error", {})
                            logger.error("chat.send error: %s", json.dumps(error)[:500])
                            return "I encountered an error processing your message."
                        status = msg.get("payload", {}).get("status")
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
            return "I'm temporarily unable to respond. The agent process may be restarting."

        if not got_final:
            # Deadline hit but the agent may have already streamed a full
            # response via event:agent. Prefer partial content over the
            # "stalled" apology when we have something to show.
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
                return response_text.strip()
            return (
                "I wasn't able to finish responding in time — the agent "
                "stalled. Please try again in a moment."
            )

        # Happy path: still log the event summary so we can audit whether
        # tool_call / tool_result / thinking events ever flowed for this turn.
        logger.info(
            "chat turn ok: resp_len=%d last_state=%s event_counts=%s",
            len(response_text),
            last_state,
            json.dumps(event_counts),
        )

        return response_text.strip() or "I processed your message but had no response."

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
