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
from pathlib import Path
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

    DEFAULT_CONFIG_PATH = Path("/home/node/.openclaw/openclaw.json")
    CLIENT_INFO = {
        "id": "openclaw-control-ui",
        "mode": "backend",
        "version": "dev",
        "platform": "linux",
    }

    def __init__(self) -> None:
        self._gateway_port: int = 3100
        self._process: Optional[subprocess.Popen] = None
        self._ready: bool = False
        self._config_path = Path(os.environ.get("OPENCLAW_CONFIG", self.DEFAULT_CONFIG_PATH))
        self._gateway_token: Optional[str] = None

    def configure(self, config: dict) -> None:
        """Configure the OpenClaw adapter. Idempotent — safe to call multiple times."""
        if "gateway_port" in config:
            self._gateway_port = config["gateway_port"]
            self._refresh_gateway_token()

            if self._process is None or self._process.poll() is not None:
                logger.info("Starting OpenClaw gateway on port %d", self._gateway_port)
                # Don't pass --token on CLI — use gateway.auth.token from
                # openclaw.json instead. CLI --token may conflict with config.
                self._process = subprocess.Popen(
                    [
                        "openclaw", "gateway",
                        "--port", str(self._gateway_port),
                    ],
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                    env={
                        **os.environ,
                        "OPENCLAW_NO_RESPAWN": "1",
                    },
                )
                self._wait_for_ready(timeout=30)
                # Re-read the effective config after startup in case OpenClaw rewrote
                # the gateway token on boot.
                self._refresh_gateway_token(required=True)

    def _refresh_gateway_token(self, required: bool = False) -> Optional[str]:
        """Load the gateway auth token from the active OpenClaw config file."""
        try:
            config = json.loads(self._config_path.read_text())
        except FileNotFoundError:
            if required:
                raise RuntimeError(f"OpenClaw config not found: {self._config_path}")
            logger.info("OpenClaw config not found yet at %s", self._config_path)
            return self._gateway_token
        except json.JSONDecodeError as exc:
            if required:
                raise RuntimeError(f"OpenClaw config is invalid JSON: {exc}") from exc
            logger.warning("Failed to parse OpenClaw config %s: %s", self._config_path, exc)
            return self._gateway_token

        token = (
            config.get("gateway", {})
            .get("auth", {})
            .get("token")
        )
        if isinstance(token, str) and token.strip():
            token = token.strip()
            if token != self._gateway_token:
                logger.info("Loaded gateway token from %s", self._config_path)
            self._gateway_token = token
            return token

        if required:
            raise RuntimeError(
                f"OpenClaw gateway.auth.token missing in {self._config_path}"
            )
        logger.warning("OpenClaw config %s does not contain gateway.auth.token", self._config_path)
        return self._gateway_token

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

        gateway_token = self._refresh_gateway_token(required=True)
        ws_url = f"ws://127.0.0.1:{self._gateway_port}"
        response_text = ""

        try:
            ws = websocket.create_connection(
                ws_url,
                timeout=120,
                origin=f"http://127.0.0.1:{self._gateway_port}",
            )

            try:
                # Step 1: Wait for connect.challenge
                challenge_raw = ws.recv()
                challenge = json.loads(challenge_raw)
                logger.info("WS step 1 received: %s", challenge_raw[:300])
                sys.stdout.flush()
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
                logger.info("WS step 2 sending connect with token=%s...", gateway_token[:10])
                ws.send(json.dumps(connect_req))

                # Wait for connect response — skip non-res messages
                while True:
                    connect_resp_raw = ws.recv()
                    connect_resp = json.loads(connect_resp_raw)
                    logger.info("WS step 2 received: type=%s ok=%s id=%s",
                                connect_resp.get("type"), connect_resp.get("ok"),
                                connect_resp.get("id"))
                    sys.stdout.flush()
                    # The connect response is type "res" with our request id
                    if connect_resp.get("type") == "res" and connect_resp.get("id") == connect_id:
                        break

                if not connect_resp.get("ok"):
                    error = connect_resp.get("error") or connect_resp.get("payload") or {}
                    logger.error("WebSocket auth failed: %s", json.dumps(error)[:500])
                    sys.stdout.flush()
                    return "I encountered an authentication error. Please try again."

                # Step 3: Send chat message
                chat_id = str(uuid.uuid4())
                ws.send(json.dumps({
                    "type": "req",
                    "id": chat_id,
                    "method": "chat.send",
                    "params": {
                        "sessionKey": "global",
                        "message": message,
                        "idempotencyKey": chat_id,
                    },
                }))

                # Step 4: Collect response events until final
                deadline = time.time() + 120
                while time.time() < deadline:
                    raw = ws.recv()
                    msg = json.loads(raw)

                    if msg.get("type") == "event" and msg.get("event") == "chat":
                        payload = msg.get("payload", {})
                        state = payload.get("state")
                        event_message = payload.get("message")
                        content = event_message.get("content") if isinstance(event_message, dict) else None
                        text = self._extract_text(content) or self._extract_text(event_message)

                        if state == "delta":
                            if text:
                                response_text = text

                        elif state == "final":
                            if text:
                                response_text = text
                            break

                        elif state == "error":
                            logger.error("chat event error: %s", payload.get("errorMessage", "unknown"))
                            return response_text or "I encountered an error processing your message."

                        elif state == "aborted":
                            break

                    elif msg.get("type") == "res" and msg.get("id") == chat_id:
                        # Response to chat.send — check for errors
                        if not msg.get("ok"):
                            error = msg.get("error", {})
                            logger.error("chat.send error: %s", json.dumps(error)[:500])
                            return "I encountered an error processing your message."
                        status = msg.get("payload", {}).get("status")
                        if status in {"started", "accepted"}:
                            continue
                        if status in {"final", "done"}:
                            break

            finally:
                ws.close()

        except Exception as exc:
            logger.error("WebSocket error: %s", str(exc)[:500])
            sys.stdout.flush()
            return f"I'm temporarily unable to respond. Error: {str(exc)[:100]}"

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
