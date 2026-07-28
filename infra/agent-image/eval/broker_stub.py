#!/usr/bin/env python3
"""Hermetic agent-broker fixture server for local eval trials.

The eval runner bind-mounts this file over ``/app/mantle_proxy.py`` in L1
candidate containers. The existing wrapper therefore starts it on
127.0.0.1:18791 without modifying the image. Trial fixtures and captures move
through a separate runner-owned bind mount.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Mapping
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from urllib.parse import urlsplit


LOGGER = logging.getLogger("agent_eval_broker_stub")
CONTROL_DIRECTORY_ENV = "AGENT_EVAL_BROKER_CONTROL_DIR"
DEFAULT_CONTROL_DIRECTORY = "/run/psd-agent-eval-broker"
TRIAL_CONFIG_FILENAME = "trial.json"
CAPTURE_FILENAME = "capture.jsonl"
MAX_REQUEST_BYTES = 50 * 1024 * 1024
MISSING_FIXTURE_ERROR = "EvalFixtureMissing"
UNSUPPORTED_METHOD_ERROR = "EvalUnsupportedAgentMethod"
INVALID_REQUEST_BODY_ERROR = "EvalInvalidRequestBody"

ALLOWED_AGENT_BROKER_ROUTES = frozenset(
    {
        "/api/agent/account-request",
        "/api/agent/aistudio",
        "/api/agent/atrium",
        "/api/agent/canva",
        "/api/agent/classified-evaluation",
        "/api/agent/workflow-gateway",
        "/api/agent/consent-link",
        "/api/agent/credentials",
        "/api/agent/directory-lookup",
        "/api/agent/email-triage",
        "/api/agent/failures",
        "/api/agent/github-execute",
        "/api/agent/schedules",
        "/api/agent/skills",
        "/api/agent/workspace-execute",
        "/api/agent/workspace-storage",
    }
)


class BrokerStubConfigurationError(RuntimeError):
    """The runner supplied an invalid or unreadable trial fixture."""


def _strict_equal(actual: object, expected: object) -> bool:
    return type(actual) is type(expected) and actual == expected


def _mapping_contains(actual: object, expected: object) -> bool:
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping):
            return False
        return all(
            key in actual and _mapping_contains(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return False
        return all(
            _mapping_contains(actual_value, expected_value)
            for actual_value, expected_value in zip(actual, expected, strict=True)
        )
    return _strict_equal(actual, expected)


class BrokerStubState:
    """Read active fixtures and append captures under a runner-owned directory."""

    def __init__(self, control_directory: Path) -> None:
        self.control_directory = control_directory
        self._capture_lock = threading.Lock()

    @property
    def trial_config_path(self) -> Path:
        return self.control_directory / TRIAL_CONFIG_FILENAME

    @property
    def capture_path(self) -> Path:
        return self.control_directory / CAPTURE_FILENAME

    def load_trial(self) -> Mapping[str, object]:
        try:
            raw = self.trial_config_path.read_text(encoding="utf-8")
            trial = json.loads(raw)
        except (OSError, json.JSONDecodeError) as error:
            raise BrokerStubConfigurationError(
                f"{MISSING_FIXTURE_ERROR}: active trial configuration is unavailable"
            ) from error
        if not isinstance(trial, Mapping):
            raise BrokerStubConfigurationError(
                f"{MISSING_FIXTURE_ERROR}: active trial configuration is not an object"
            )
        fixtures = trial.get("fixtures")
        if not isinstance(fixtures, list):
            raise BrokerStubConfigurationError(
                f"{MISSING_FIXTURE_ERROR}: active trial fixtures are not a list"
            )
        return trial

    def find_fixture(
        self,
        trial: Mapping[str, object],
        *,
        route: str,
        method: str,
        body: object,
    ) -> Mapping[str, object] | None:
        fixtures = trial["fixtures"]
        if not isinstance(fixtures, list):
            return None
        for fixture in fixtures:
            if not isinstance(fixture, Mapping):
                continue
            if fixture.get("route") != route:
                continue
            fixture_method = fixture.get("method", "POST")
            if not isinstance(fixture_method, str) or fixture_method.upper() != method:
                continue
            expected_body = fixture.get("request_body")
            if expected_body is not None and not _mapping_contains(body, expected_body):
                continue
            return fixture
        return None

    def capture(self, record: Mapping[str, object]) -> None:
        serialized = json.dumps(record, separators=(",", ":")) + "\n"
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        flags |= getattr(os, "O_NOFOLLOW", 0)
        with self._capture_lock:
            descriptor = os.open(self.capture_path, flags, 0o600)
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                    handle.write(serialized)
            except Exception:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                raise


class BrokerStubServer(ThreadingHTTPServer):
    """Threaded loopback server carrying its isolated trial state."""

    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        state: BrokerStubState,
    ) -> None:
        self.state = state
        super().__init__(server_address, BrokerStubRequestHandler)


class BrokerStubRequestHandler(BaseHTTPRequestHandler):
    """Serve control endpoints and the fixed agent-broker allowlist."""

    server: BrokerStubServer
    protocol_version = "HTTP/1.1"
    server_version = "AgentEvalBrokerStub/1"
    sys_version = ""
    CONTROL_ENDPOINTS: ClassVar[frozenset[str]] = frozenset(
        {
            "/health",
            "/usage",
            "/internal/finalization/begin",
            "/internal/finalization/end",
        }
    )

    def log_message(self, format_string: str, *arguments: object) -> None:
        LOGGER.debug(format_string, *arguments)

    def _send_json(self, status: int, body: object) -> None:
        serialized = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(serialized)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(serialized)

    def _read_body(self) -> tuple[bytes, object]:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise BrokerStubConfigurationError("invalid Content-Length") from error
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise BrokerStubConfigurationError("request body exceeds eval stub limit")
        raw = self.rfile.read(length)
        if not raw:
            return raw, None
        try:
            return raw, json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return raw, raw.decode("utf-8", errors="replace")

    def _handle_control(self, path: str) -> bool:
        if path == "/health" and self.command == "GET":
            self._send_json(HTTPStatus.OK, {"ok": True, "mode": "eval-stub"})
            return True
        if path == "/usage" and self.command == "GET":
            self._send_json(
                HTTPStatus.OK,
                {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_write_input_tokens": 0,
                    "usage_events": 0,
                    "model": None,
                },
            )
            return True
        if path == "/internal/finalization/begin" and self.command == "POST":
            self._read_body()
            self._send_json(HTTPStatus.OK, {"finalizing": True})
            return True
        if path == "/internal/finalization/end" and self.command == "POST":
            self._read_body()
            self._send_json(HTTPStatus.OK, {"finalizing": False})
            return True
        if path in self.CONTROL_ENDPOINTS:
            self._send_json(
                HTTPStatus.METHOD_NOT_ALLOWED,
                {"error": "EvalControlMethodNotAllowed"},
            )
            return True
        return False

    def _handle_agent_broker(self, path: str) -> None:
        prefix = "/agent-broker"
        route = path[len(prefix) :]
        body: object = None
        try:
            _, body = self._read_body()
            trial = self.server.state.load_trial()
            trial_id = trial.get("trial_id")
            task_id = trial.get("task_id")
            request_error: str | None = None
            response_status = HTTPStatus.NOT_FOUND
            if route not in ALLOWED_AGENT_BROKER_ROUTES:
                request_error = (
                    f"EvalUnsupportedAgentRoute: {self.command} {route}"
                )
            elif self.command != "POST":
                request_error = (
                    f"{UNSUPPORTED_METHOD_ERROR}: {self.command} {route}"
                )
            elif not isinstance(body, Mapping):
                request_error = (
                    f"{INVALID_REQUEST_BODY_ERROR}: POST {route} "
                    "requires a JSON object"
                )
                response_status = HTTPStatus.BAD_REQUEST
            if request_error is not None:
                self.server.state.capture(
                    {
                        "trial_id": trial_id,
                        "task_id": task_id,
                        "route": route,
                        "method": self.command,
                        "headers": {
                            key.lower(): value
                            for key, value in self.headers.items()
                        },
                        "body": body,
                        "stub_error": request_error,
                    }
                )
                self._send_json(
                    response_status,
                    {
                        "error": request_error.split(":", 1)[0],
                        "message": request_error,
                        "route": route,
                    },
                )
                return
            fixture = self.server.state.find_fixture(
                trial,
                route=route,
                method=self.command,
                body=body,
            )
            error: str | None = None
            if fixture is None:
                error = (
                    f"{MISSING_FIXTURE_ERROR}: no fixture for "
                    f"{self.command} {route}"
                )
            self.server.state.capture(
                {
                    "trial_id": trial_id,
                    "task_id": task_id,
                    "route": route,
                    "method": self.command,
                    "headers": {
                        key.lower(): value
                        for key, value in self.headers.items()
                    },
                    "body": body,
                    "stub_error": error,
                }
            )
            if fixture is None:
                self._send_json(
                    HTTPStatus.NOT_IMPLEMENTED,
                    {
                        "error": MISSING_FIXTURE_ERROR,
                        "message": error,
                        "route": route,
                    },
                )
                return
            response = fixture.get("response", {})
            if not isinstance(response, Mapping):
                raise BrokerStubConfigurationError(
                    f"fixture response for {route} is not an object"
                )
            status = response.get("status", HTTPStatus.OK)
            if (
                isinstance(status, bool)
                or not isinstance(status, int)
                or status < 100
                or status > 599
            ):
                raise BrokerStubConfigurationError(
                    f"fixture response status for {route} is invalid"
                )
            self._send_json(status, response.get("body", {}))
        except BrokerStubConfigurationError as error:
            message = str(error)
            try:
                self.server.state.capture(
                    {
                        "trial_id": None,
                        "task_id": None,
                        "route": route,
                        "method": self.command,
                        "headers": {
                            key.lower(): value
                            for key, value in self.headers.items()
                        },
                        "body": body,
                        "stub_error": message,
                    }
                )
            except OSError:
                pass
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": MISSING_FIXTURE_ERROR, "message": message},
            )

    def _handle(self) -> None:
        path = urlsplit(self.path).path
        if self._handle_control(path):
            return
        if path.startswith("/agent-broker/"):
            self._handle_agent_broker(path)
            return
        self._send_json(
            HTTPStatus.NOT_FOUND,
            {"error": "EvalUnsupportedPath"},
        )

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_PATCH = _handle
    do_DELETE = _handle


def create_server(
    control_directory: Path,
    *,
    host: str = "127.0.0.1",
    port: int = 18791,
) -> BrokerStubServer:
    control_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(control_directory, 0o700)
    return BrokerStubServer((host, port), BrokerStubState(control_directory))


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    control_directory = Path(
        os.environ.get(CONTROL_DIRECTORY_ENV, DEFAULT_CONTROL_DIRECTORY)
    )
    server = create_server(control_directory)
    LOGGER.info(
        "starting eval broker stub on 127.0.0.1:18791 with %d routes",
        len(ALLOWED_AGENT_BROKER_ROUTES),
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
