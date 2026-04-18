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

    # Gateway auth token — must match gateway.auth.token in openclaw.json.
    GATEWAY_TOKEN = "psd-agent-internal-gateway-token"

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

        ws_url = f"ws://127.0.0.1:{self._gateway_port}"
        response_text = ""

        try:
            ws = websocket.create_connection(ws_url, timeout=120)

            try:
                # Step 1: Wait for connect.challenge
                challenge_raw = ws.recv()
                challenge = json.loads(challenge_raw)
                logger.info("WS step 1 received: %s", challenge_raw[:300])
                sys.stdout.flush()

                # Step 2: Authenticate
                connect_id = str(uuid.uuid4())
                connect_req = {
                    "type": "req",
                    "id": connect_id,
                    "method": "connect",
                    "params": {
                        "minProtocol": 3,
                        "maxProtocol": 3,
                        "auth": {"token": self.GATEWAY_TOKEN},
                        "role": "operator",
                        "scopes": ["operator.admin", "operator.read", "operator.write"],
                    },
                }
                logger.info("WS step 2 sending connect with token=%s...", self.GATEWAY_TOKEN[:10])
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
                    # Also accept top-level ok for simpler protocol versions
                    if "ok" in connect_resp:
                        break

                if not connect_resp.get("ok"):
                    logger.error("WebSocket auth failed: %s", connect_resp_raw[:500])
                    sys.stdout.flush()
                    return "I encountered an authentication error. Please try again."

                # Step 3: Send chat message
                chat_id = str(uuid.uuid4())
                ws.send(json.dumps({
                    "type": "req",
                    "id": chat_id,
                    "method": "chat.send",
                    "params": {
                        "sessionKey": session_id,
                        "message": message,
                        "idempotencyKey": str(uuid.uuid4()),
                    },
                }))

                # Step 4: Collect response events until final
                deadline = time.time() + 120
                while time.time() < deadline:
                    raw = ws.recv()
                    msg = json.loads(raw)

                    if msg.get("event") == "chat":
                        payload = msg.get("payload", {})
                        state = payload.get("state")

                        if state == "delta":
                            # Accumulate streaming text
                            content = payload.get("message", {}).get("content", "")
                            if isinstance(content, str):
                                response_text += content
                            elif isinstance(content, list):
                                for block in content:
                                    if isinstance(block, dict) and block.get("type") == "text":
                                        response_text += block.get("text", "")

                        elif state == "final":
                            # Extract final text if we didn't get deltas
                            if not response_text:
                                final_content = payload.get("message", {}).get("content", "")
                                response_text = self._extract_text(final_content)
                            break

                    elif msg.get("type") == "res" and msg.get("id") == chat_id:
                        # Response to chat.send — check for errors
                        if not msg.get("ok"):
                            error = msg.get("error", {})
                            logger.error("chat.send error: %s", json.dumps(error)[:500])
                            return "I encountered an error processing your message."

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
