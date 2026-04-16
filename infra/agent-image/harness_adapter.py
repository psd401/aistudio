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
    def process(self, message: str, session_id: str) -> str:
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

    OpenClaw exposes a local HTTP gateway. The adapter sends messages via HTTP
    and collects the streamed response. The gateway is started as a subprocess
    when the adapter is configured.
    """

    def __init__(self) -> None:
        self._gateway_url: str = "http://127.0.0.1:3100"
        self._process: Optional[subprocess.Popen] = None
        self._ready: bool = False
        self._model_override: Optional[str] = None

    def configure(self, config: dict) -> None:
        """Configure the OpenClaw adapter. Idempotent — safe to call multiple times.

        Supported config keys:
          - gateway_port (int): Port for the OpenClaw gateway. When provided,
            starts the gateway process if not already running.
          - model (str): Override the default model for subsequent requests.
            Can be set without restarting the gateway.
        """
        # Capture model override for use in process() requests
        model = config.get("model")
        if model:
            logger.info("Model override set: %s", model)
            self._model_override = model

        # Only update the gateway URL and start the process when gateway_port
        # is explicitly provided. This prevents a model-only configure() call
        # from resetting the URL or re-evaluating process state unnecessarily.
        if "gateway_port" in config:
            gateway_port = config["gateway_port"]
            self._gateway_url = f"http://127.0.0.1:{gateway_port}"

            if self._process is None or self._process.poll() is not None:
                logger.info("Starting OpenClaw gateway on port %d", gateway_port)
                # Forward stdout/stderr to container logs instead of PIPE to avoid
                # deadlock when the OS pipe buffer (~64KB) fills without a reader.
                self._process = subprocess.Popen(
                    ["openclaw", "gateway", "--port", str(gateway_port)],
                    stdout=sys.stdout,
                    stderr=sys.stderr,
                    env={**os.environ},
                )
                # Wait for gateway to become ready (up to 30 seconds)
                self._wait_for_ready(timeout=30)

    def _wait_for_ready(self, timeout: int = 30) -> None:
        """Poll the gateway health endpoint until ready."""
        import urllib.request
        import urllib.error

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                req = urllib.request.Request(f"{self._gateway_url}/health")
                with urllib.request.urlopen(req, timeout=2) as resp:
                    if resp.status == 200:
                        self._ready = True
                        logger.info("OpenClaw gateway is ready")
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(1)

        logger.warning("OpenClaw gateway did not become ready within %ds", timeout)
        self._ready = False

    def process(self, message: str, session_id: str) -> str:
        """Send a message to OpenClaw and return the full response."""
        import urllib.request
        import urllib.error

        if not self._ready:
            return "Agent is starting up. Please try again in a moment."

        request_data: dict = {
            "message": message,
            "sessionId": session_id,
        }
        if self._model_override:
            request_data["model"] = self._model_override

        payload = json.dumps(request_data).encode("utf-8")

        req = urllib.request.Request(
            f"{self._gateway_url}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8")
                # OpenClaw gateway returns JSON with a "response" field
                try:
                    data = json.loads(body)
                    return data.get("response", body)
                except json.JSONDecodeError:
                    return body
        except urllib.error.HTTPError as exc:
            logger.error("OpenClaw HTTP error: %d %s", exc.code, exc.reason)
            return f"I encountered an error processing your message. (HTTP {exc.code})"
        except urllib.error.URLError as exc:
            logger.error("OpenClaw connection error: %s", exc.reason)
            return "I'm temporarily unable to respond. The agent process may be restarting."

    def health(self) -> bool:
        """Check if the OpenClaw gateway is responsive."""
        return self._ready

    def shutdown(self) -> None:
        """Stop the OpenClaw gateway process."""
        if self._process and self._process.poll() is None:
            logger.info("Stopping OpenClaw gateway")
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
