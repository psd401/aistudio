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

    OpenClaw gateway uses WebSocket, not HTTP REST. The adapter uses the
    `openclaw agent` CLI command which handles the WebSocket connection
    internally and returns the response as JSON.
    """

    # Gateway auth token — must match gateway.auth.token in openclaw.json.
    GATEWAY_TOKEN = "psd-agent-internal-gateway-token"

    def __init__(self) -> None:
        self._gateway_port: int = 3100
        self._process: Optional[subprocess.Popen] = None
        self._ready: bool = False

    def configure(self, config: dict) -> None:
        """Configure the OpenClaw adapter. Idempotent — safe to call multiple times.

        Supported config keys:
          - gateway_port (int): Port for the OpenClaw gateway. When provided,
            starts the gateway process if not already running.
        """
        if "gateway_port" in config:
            self._gateway_port = config["gateway_port"]

            if self._process is None or self._process.poll() is not None:
                logger.info("Starting OpenClaw gateway on port %d", self._gateway_port)
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
        """Send a message to OpenClaw via the CLI and return the response.

        Uses `openclaw agent` which connects to the gateway via WebSocket
        internally. Returns the agent's text response.
        """
        if not self._ready:
            raise RuntimeError(
                "OpenClaw gateway is not ready — configure() with gateway_port "
                "must be called before process()"
            )

        cmd = [
            "openclaw", "agent",
            "-m", message,
            "--session-id", session_id,
            "--url", f"ws://127.0.0.1:{self._gateway_port}",
            "--token", self.GATEWAY_TOKEN,
            "--json",
            "--timeout", "120",
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=130,
                env={
                    **os.environ,
                    "OPENCLAW_NO_RESPAWN": "1",
                    "NO_COLOR": "1",
                },
            )

            if result.returncode != 0:
                logger.error(
                    "OpenClaw agent command failed: exit=%d stderr=%s stdout=%s",
                    result.returncode,
                    result.stderr[:500] if result.stderr else "(empty)",
                    result.stdout[:500] if result.stdout else "(empty)",
                )
                return "I encountered an error processing your message. Please try again."

            # Parse JSON output
            try:
                data = json.loads(result.stdout)
                # The CLI outputs { text: "...", ... } or { response: "...", ... }
                return (
                    data.get("text")
                    or data.get("response")
                    or data.get("message")
                    or result.stdout.strip()
                )
            except json.JSONDecodeError:
                # Non-JSON output — return raw text (strip ANSI/emoji)
                return result.stdout.strip() or "I processed your message but had no response."

        except subprocess.TimeoutExpired:
            logger.error("OpenClaw agent command timed out after 130s")
            return "I'm taking too long to respond. Please try a shorter question."
        except Exception as exc:
            logger.error("OpenClaw agent command error: %s", exc)
            return "I'm temporarily unable to respond. The agent process may be restarting."

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
