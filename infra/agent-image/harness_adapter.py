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

    Uses the OpenAI-compatible /v1/chat/completions HTTP endpoint exposed
    by the gateway (enabled via gateway.http.endpoints.chatCompletions).
    This is simpler and more reliable than the WebSocket CLI approach.
    """

    # Gateway auth token — must match gateway.auth.token in openclaw.json.
    GATEWAY_TOKEN = "psd-agent-internal-gateway-token"

    def __init__(self) -> None:
        self._gateway_port: int = 3100
        self._gateway_url: str = "http://127.0.0.1:3100"
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
            self._gateway_url = f"http://127.0.0.1:{self._gateway_port}"

            if self._process is None or self._process.poll() is not None:
                logger.info("Starting OpenClaw gateway on port %d", self._gateway_port)
                self._process = subprocess.Popen(
                    [
                        "openclaw", "gateway",
                        "--port", str(self._gateway_port),
                        "--token", self.GATEWAY_TOKEN,
                        "--verbose",
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

        url = f"{self._gateway_url}/health"
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
        """Send a message via the OpenAI-compatible /v1/chat/completions endpoint.

        This endpoint is enabled via gateway.http.endpoints.chatCompletions
        in openclaw.json. It accepts standard OpenAI chat format and returns
        the agent's response.
        """
        import urllib.request
        import urllib.error

        if not self._ready:
            raise RuntimeError(
                "OpenClaw gateway is not ready — configure() with gateway_port "
                "must be called before process()"
            )

        # OpenAI chat completions format
        request_data = {
            "messages": [
                {"role": "user", "content": message}
            ],
            "stream": False,
        }
        if model_override:
            request_data["model"] = model_override

        payload = json.dumps(request_data).encode("utf-8")

        req = urllib.request.Request(
            f"{self._gateway_url}/v1/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.GATEWAY_TOKEN}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8")
                data = json.loads(body)
                # Standard OpenAI response format
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "")
                return data.get("response", body)
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")[:1000]
            logger.error(
                "OpenClaw HTTP error: %d %s body=%s",
                exc.code, exc.reason, error_body,
            )
            sys.stdout.flush()
            return f"I encountered an error processing your message. (HTTP {exc.code})"
        except urllib.error.URLError as exc:
            logger.error("OpenClaw connection error: %s", exc.reason)
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
