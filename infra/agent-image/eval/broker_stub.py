#!/usr/bin/env python3
"""Hermetic agent-broker fixture server for local eval trials.

The eval runner bind-mounts this file over ``/app/mantle_proxy.py`` in L1
candidate containers. The existing wrapper therefore starts it on
127.0.0.1:18791 without modifying the image. Trial fixtures and captures move
through a root-owned in-container tmpfs. Mantle candidates also use that same
root-owned process for model inference, so the stub preserves the production
relay's exact, allowlisted model routes instead of intercepting them as fixture
traffic.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import uuid
from collections.abc import Mapping
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit


LOGGER = logging.getLogger("agent_eval_broker_stub")
CANDIDATE_MANTLE_API = os.environ.pop("CANDIDATE_MANTLE_API", "").strip()
CANDIDATE_MANTLE_BASE_URL = os.environ.pop(
    "CANDIDATE_MANTLE_BASE_URL", ""
).strip()
CANDIDATE_MANTLE_BEARER_TOKEN = os.environ.pop(
    "CANDIDATE_MANTLE_BEARER_TOKEN", ""
).strip()
CANDIDATE_MANTLE_MODEL_ID = os.environ.pop(
    "CANDIDATE_MANTLE_MODEL_ID", ""
).strip()
CANDIDATE_MANTLE_PREFIX = "candidate-mantle"
CANDIDATE_MANTLE_OPERATIONS = {
    "openai-completions": (
        frozenset({("GET", "models"), ("POST", "chat/completions")}),
        "/v1",
    ),
    "anthropic-messages": (
        frozenset({("POST", "v1/messages")}),
        "/anthropic",
    ),
}
CANDIDATE_MANTLE_HOST_RE = re.compile(
    r"bedrock-mantle\.[a-z0-9-]+\.api\.aws"
)
CONTROL_DIRECTORY_ENV = "AGENT_EVAL_BROKER_CONTROL_DIR"
DEFAULT_CONTROL_DIRECTORY = "/run/psd-agent-eval-broker"
DEFAULT_WORKSPACE_FLUSH_TOKEN_PATH = (
    "/run/psd-agent-authority/workspace-flush-token"
)
DEFAULT_INVOCATION_CONTEXT_PATH = (
    "/run/psd-agent-authority/invocation-context"
)
DEFAULT_REQUEST_PROOF_KEY_PATH = (
    "/run/psd-agent-authority/request-proof-key"
)
TRIAL_CONFIG_FILENAME = "trial.json"
CAPTURE_FILENAME = "capture.jsonl"
MAX_REQUEST_BYTES = 50 * 1024 * 1024
MAX_MODEL_RESPONSE_BYTES = 50 * 1024 * 1024
FINALIZATION_DRAIN_TIMEOUT_SECONDS = 120
MISSING_FIXTURE_ERROR = "EvalFixtureMissing"
UNSUPPORTED_METHOD_ERROR = "EvalUnsupportedAgentMethod"
INVALID_REQUEST_BODY_ERROR = "EvalInvalidRequestBody"
FINALIZING_ERROR = "EvalFinalizationInProgress"
RUNNER_WRITE_TRIAL_COMMAND = "--runner-write-trial"
RUNNER_READ_CAPTURES_COMMAND = "--runner-read-captures"
RUNNER_CONTROL_TOKEN_FILENAME = "runner-control-token"
RUNNER_CONTROL_HEADER = "X-Agent-Eval-Runner-Control"
RUNNER_OPEN_TRIAL_PATH = "/internal/eval-trial/open"
MODEL_MESSAGES_PATH = "/anthropic/v1/messages"
MODEL_PROXY_ROUTE = "/api/agent/model-proxy/anthropic/v1/messages"

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


class CandidateMantleAuthorityUnavailable(BrokerStubConfigurationError):
    """A paid candidate inference arrived outside an authorized trial."""


def _candidate_mantle_configuration() -> tuple[str, str, str, str] | None:
    """Validate the root-only direct-Mantle relay environment."""

    values = (
        CANDIDATE_MANTLE_API,
        CANDIDATE_MANTLE_BASE_URL,
        CANDIDATE_MANTLE_BEARER_TOKEN,
        CANDIDATE_MANTLE_MODEL_ID,
    )
    if not any(values):
        return None
    if (
        not all(values)
        or CANDIDATE_MANTLE_API not in CANDIDATE_MANTLE_OPERATIONS
    ):
        raise BrokerStubConfigurationError(
            "candidate Mantle relay configuration is incomplete"
        )
    _, expected_base_path = CANDIDATE_MANTLE_OPERATIONS[
        CANDIDATE_MANTLE_API
    ]
    parsed = urlsplit(CANDIDATE_MANTLE_BASE_URL)
    try:
        port = parsed.port
    except ValueError as error:
        raise BrokerStubConfigurationError(
            "candidate Mantle base URL has an invalid port"
        ) from error
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or not CANDIDATE_MANTLE_HOST_RE.fullmatch(parsed.hostname)
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.path != expected_base_path
        or parsed.query
        or parsed.fragment
    ):
        raise BrokerStubConfigurationError(
            "candidate Mantle base URL is not an exact AWS endpoint"
        )
    return values


def _resolve_candidate_mantle_request(
    method: str,
    path: str,
    body: bytes | None,
    configuration: tuple[str, str, str, str] | None,
) -> str | None:
    """Map one fixed model operation to the configured AWS endpoint."""

    prefix = f"/{CANDIDATE_MANTLE_PREFIX}/"
    if not path.startswith(prefix):
        return None
    if configuration is None:
        raise BrokerStubConfigurationError(
            "candidate Mantle relay is disabled"
        )
    provider_api, base_url, _, model_id = configuration
    allowed_operations, _ = CANDIDATE_MANTLE_OPERATIONS[provider_api]
    relative_path = path[len(prefix) :]
    if (method, relative_path) not in allowed_operations:
        raise BrokerStubConfigurationError(
            "unsupported candidate Mantle operation"
        )
    if method == "GET":
        return f"{base_url}/{relative_path}"
    try:
        payload = json.loads(body) if body else None
    except (TypeError, ValueError) as error:
        raise BrokerStubConfigurationError(
            "candidate Mantle request must be JSON"
        ) from error
    if not isinstance(payload, Mapping) or payload.get("model") != model_id:
        raise BrokerStubConfigurationError(
            "candidate Mantle request model does not match"
        )
    return f"{base_url}/{relative_path}"


def _trusted_app_base_url(value: str) -> bool:
    return value.startswith(
        ("https://", "http://127.0.0.1", "http://localhost")
    )


def _read_invocation_authority(
    invocation_context_path: Path,
    request_proof_key_path: Path,
) -> tuple[str, bytes]:
    context = invocation_context_path.read_text(encoding="ascii").strip()
    encoded_key = request_proof_key_path.read_text(encoding="ascii").strip()
    padded_key = encoded_key + ("=" * (-len(encoded_key) % 4))
    try:
        proof_key = base64.urlsafe_b64decode(padded_key)
    except (ValueError, binascii.Error) as error:
        raise BrokerStubConfigurationError(
            "invocation request proof key is malformed"
        ) from error
    if not context or len(proof_key) != 32:
        raise BrokerStubConfigurationError(
            "invocation authority is malformed"
        )
    return context, proof_key


def _authority_headers(
    method: str,
    route: str,
    body: bytes,
    *,
    invocation_context_path: Path,
    request_proof_key_path: Path,
) -> dict[str, str]:
    context, proof_key = _read_invocation_authority(
        invocation_context_path,
        request_proof_key_path,
    )
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    body_sha256 = hashlib.sha256(body).hexdigest()
    canonical = "\n".join(
        [
            "v1",
            timestamp,
            nonce,
            method.upper(),
            route,
            body_sha256,
        ]
    ).encode("utf-8")
    signature = base64.urlsafe_b64encode(
        hmac.new(proof_key, canonical, hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    return {
        "X-Agent-Invocation-Context": context,
        "X-Agent-Request-Proof-Version": "v1",
        "X-Agent-Request-Proof-Timestamp": timestamp,
        "X-Agent-Request-Proof-Nonce": nonce,
        "X-Agent-Request-Proof-Body-Sha256": body_sha256,
        "X-Agent-Request-Proof-Signature": signature,
    }


class _NoRedirectHandler(urllib_request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib_request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> None:
        return None


def _ensure_runner_control_token(control_directory: Path) -> str:
    """Create or reuse the root-only token for runner-owned gate transitions."""

    path = control_directory / RUNNER_CONTROL_TOKEN_FILENAME
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        read_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, read_flags)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "r", encoding="ascii") as handle:
            token = handle.read().strip()
    else:
        token = secrets.token_urlsafe(32)
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(token)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    if len(token) != 43:
        raise BrokerStubConfigurationError(
            "runner control token is malformed"
        )
    return token


def activate_installed_trial(
    control_directory: Path,
    *,
    host: str = "127.0.0.1",
    port: int = 18791,
) -> None:
    """Open the in-process gate only after root installed the next trial."""

    token_path = control_directory / RUNNER_CONTROL_TOKEN_FILENAME
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(token_path, flags)
    with os.fdopen(descriptor, "r", encoding="ascii") as handle:
        token = handle.read().strip()
    request = urllib_request.Request(
        f"http://{host}:{port}{RUNNER_OPEN_TRIAL_PATH}",
        data=b"",
        method="POST",
        headers={RUNNER_CONTROL_HEADER: token},
    )
    try:
        with urllib_request.urlopen(request, timeout=5) as response:
            if response.status != HTTPStatus.OK:
                raise BrokerStubConfigurationError(
                    f"runner gate open returned {response.status}"
                )
    except urllib_error.HTTPError as error:
        error.read(500)
        raise BrokerStubConfigurationError(
            f"runner gate open returned {error.code}"
        ) from error
    except urllib_error.URLError as error:
        raise BrokerStubConfigurationError(
            f"runner gate open failed: {error.reason}"
        ) from error


def install_trial_configuration(
    control_directory: Path,
    serialized: bytes,
) -> None:
    """Atomically install trial state inside the root-owned control tmpfs."""

    try:
        configuration = json.loads(serialized)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BrokerStubConfigurationError(
            "runner trial configuration is not valid JSON"
        ) from error
    if not isinstance(configuration, Mapping):
        raise BrokerStubConfigurationError(
            "runner trial configuration must be an object"
        )
    control_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(control_directory, 0o700)

    capture_path = control_directory / CAPTURE_FILENAME
    capture_flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    capture_flags |= getattr(os, "O_NOFOLLOW", 0)
    capture_descriptor = os.open(capture_path, capture_flags, 0o600)
    try:
        os.fchmod(capture_descriptor, 0o600)
    finally:
        os.close(capture_descriptor)

    temporary_path = control_directory / (
        f".{TRIAL_CONFIG_FILENAME}.{uuid.uuid4().hex}.tmp"
    )
    trial_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    trial_flags |= getattr(os, "O_NOFOLLOW", 0)
    trial_descriptor = os.open(temporary_path, trial_flags, 0o600)
    try:
        os.fchmod(trial_descriptor, 0o600)
        with os.fdopen(trial_descriptor, "wb") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, control_directory / TRIAL_CONFIG_FILENAME)
    except Exception:
        try:
            os.close(trial_descriptor)
        except OSError:
            pass
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def collect_trial_captures(control_directory: Path) -> bytes:
    """Read the capture and remove the no-longer-active trial config."""

    capture_path = control_directory / CAPTURE_FILENAME
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(capture_path, flags)
    except FileNotFoundError:
        serialized = b""
    else:
        with os.fdopen(descriptor, "rb") as handle:
            serialized = handle.read()
    try:
        (control_directory / TRIAL_CONFIG_FILENAME).unlink()
    except FileNotFoundError:
        pass
    return serialized


def install_and_activate_trial(
    control_directory: Path,
    serialized: bytes,
    *,
    host: str = "127.0.0.1",
    port: int = 18791,
) -> None:
    """Install the next trial and then cross its authenticated gate boundary."""

    install_trial_configuration(control_directory, serialized)
    activate_installed_trial(
        control_directory,
        host=host,
        port=port,
    )


def _strict_equal(actual: object, expected: object) -> bool:
    return type(actual) is type(expected) and actual == expected


def mapping_contains(actual: object, expected: object) -> bool:
    """Return whether ``actual`` recursively contains the fixture selector.

    Mapping selectors may address list positions with non-negative integer
    keys (JSON fixture files encode them as strings). When the actual value is
    a JSON string, a mapping selector applies to the decoded value. This lets
    fixtures constrain structured ``--params``/``--json`` argv tokens without
    depending on key order or unrelated injected fields.
    """

    if isinstance(expected, Mapping):
        if set(expected) == {"$matches_any"}:
            alternatives = expected["$matches_any"]
            return (
                isinstance(alternatives, list)
                and bool(alternatives)
                and any(
                    mapping_contains(actual, alternative)
                    for alternative in alternatives
                )
            )
        if set(expected) == {"$text_equals"}:
            expected_text = expected["$text_equals"]
            return (
                isinstance(actual, str)
                and isinstance(expected_text, str)
                and actual.strip() == expected_text.strip()
            )
        if isinstance(actual, str):
            try:
                actual = json.loads(actual)
            except json.JSONDecodeError:
                return False
        if isinstance(actual, Mapping):
            return all(
                key in actual and mapping_contains(actual[key], value)
                for key, value in expected.items()
            )
        if isinstance(actual, list):
            for key, value in expected.items():
                if isinstance(key, bool):
                    return False
                if isinstance(key, int):
                    index = key
                elif isinstance(key, str) and key.isdigit():
                    index = int(key)
                else:
                    return False
                if index >= len(actual) or not mapping_contains(actual[index], value):
                    return False
            return True
        return False
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return False
        return all(
            mapping_contains(actual_value, expected_value)
            for actual_value, expected_value in zip(actual, expected, strict=True)
        )
    return _strict_equal(actual, expected)


class BrokerStubState:
    """Read fixtures and append captures under a root-owned directory."""

    def __init__(
        self,
        control_directory: Path,
        *,
        workspace_flush_token_path: Path | None = None,
        invocation_context_path: Path | None = None,
        request_proof_key_path: Path | None = None,
        model_upstream_base_url: str | None = None,
    ) -> None:
        self.control_directory = control_directory
        self.workspace_flush_token_path = (
            workspace_flush_token_path
            or Path(DEFAULT_WORKSPACE_FLUSH_TOKEN_PATH)
        )
        self.invocation_context_path = (
            invocation_context_path
            or Path(DEFAULT_INVOCATION_CONTEXT_PATH)
        )
        self.request_proof_key_path = (
            request_proof_key_path
            or Path(DEFAULT_REQUEST_PROOF_KEY_PATH)
        )
        configured_upstream = (
            os.environ.get("APP_BASE_URL", "")
            if model_upstream_base_url is None
            else model_upstream_base_url
        ).rstrip("/")
        if not _trusted_app_base_url(configured_upstream):
            raise BrokerStubConfigurationError(
                "APP_BASE_URL is not a trusted model broker URL"
            )
        self.model_upstream_base_url = configured_upstream
        self.candidate_mantle_configuration = (
            _candidate_mantle_configuration()
        )
        self._runner_control_token = _ensure_runner_control_token(
            control_directory
        )
        self._capture_lock = threading.Lock()
        self._finalization_condition = threading.Condition()
        self._finalization_state = "closed"
        self._active_requests = 0

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
            if expected_body is not None and not mapping_contains(body, expected_body):
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

    def valid_flush_token(self, supplied_token: str | None) -> bool:
        try:
            expected_token = self.workspace_flush_token_path.read_text(
                encoding="ascii"
            ).strip()
        except OSError:
            return False
        return (
            isinstance(supplied_token, str)
            and bool(expected_token)
            and hmac.compare_digest(supplied_token, expected_token)
        )

    def valid_runner_control_token(self, supplied_token: str | None) -> bool:
        return (
            isinstance(supplied_token, str)
            and hmac.compare_digest(
                supplied_token,
                self._runner_control_token,
            )
        )

    def forward_model_request(
        self,
        body: bytes,
        *,
        content_type: str,
        accept: str,
    ) -> tuple[int, str, bytes]:
        """Relay the one loopback model endpoint used by psd-summarize."""

        headers = {
            "Content-Type": content_type,
            "Accept": accept,
            **_authority_headers(
                "POST",
                MODEL_PROXY_ROUTE,
                body,
                invocation_context_path=self.invocation_context_path,
                request_proof_key_path=self.request_proof_key_path,
            ),
        }
        request = urllib_request.Request(
            f"{self.model_upstream_base_url}{MODEL_PROXY_ROUTE}",
            data=body,
            method="POST",
            headers=headers,
        )
        opener = urllib_request.build_opener(_NoRedirectHandler())
        try:
            response = opener.open(request, timeout=300)
        except urllib_error.HTTPError as error:
            response = error
        try:
            response_body = response.read(MAX_MODEL_RESPONSE_BYTES + 1)
            if len(response_body) > MAX_MODEL_RESPONSE_BYTES:
                raise BrokerStubConfigurationError(
                    "model broker response exceeds eval stub limit"
                )
            return (
                response.status,
                response.headers.get(
                    "Content-Type",
                    "application/octet-stream",
                ),
                response_body,
            )
        finally:
            response.close()

    def forward_candidate_mantle_request(
        self,
        method: str,
        path: str,
        body: bytes | None,
        request_headers: Mapping[str, str],
    ) -> tuple[int, str, bytes]:
        """Preserve the production candidate relay while L1 fixtures are active.

        Candidate model traffic is deliberately never written to the fixture
        capture. It can contain prompts and tool arguments, while eval records
        retain only the resulting pass/fail and operational metadata.
        """

        upstream = _resolve_candidate_mantle_request(
            method,
            path,
            body,
            self.candidate_mantle_configuration,
        )
        if upstream is None or self.candidate_mantle_configuration is None:
            raise BrokerStubConfigurationError(
                "candidate Mantle relay is unavailable"
            )
        if method != "GET":
            try:
                _read_invocation_authority(
                    self.invocation_context_path,
                    self.request_proof_key_path,
                )
            except (OSError, ValueError) as error:
                raise CandidateMantleAuthorityUnavailable(
                    "invocation authority is unavailable"
                ) from error

        _, _, bearer_token, model_id = self.candidate_mantle_configuration
        excluded_headers = {
            "accept-encoding",
            "authorization",
            "connection",
            "content-length",
            "host",
            "transfer-encoding",
            "x-api-key",
            "x-agent-invocation-context",
            "x-agent-request-proof-version",
            "x-agent-request-proof-timestamp",
            "x-agent-request-proof-nonce",
            "x-agent-request-proof-body-sha256",
            "x-agent-request-proof-signature",
        }
        headers = {
            key: value
            for key, value in request_headers.items()
            if key.lower() not in excluded_headers
        }
        headers["Authorization"] = f"Bearer {bearer_token}"
        request = urllib_request.Request(
            upstream,
            data=body if method != "GET" else None,
            method=method,
            headers=headers,
        )
        opener = urllib_request.build_opener(_NoRedirectHandler())
        try:
            response = opener.open(request, timeout=300)
        except urllib_error.HTTPError as error:
            response = error
        try:
            response_body = response.read(MAX_MODEL_RESPONSE_BYTES + 1)
            if len(response_body) > MAX_MODEL_RESPONSE_BYTES:
                raise BrokerStubConfigurationError(
                    "candidate Mantle response exceeds eval stub limit"
                )
            LOGGER.info(
                "candidate Mantle relay method=%s path=%s model=%s status=%d bytes=%d",
                method,
                path,
                model_id,
                response.status,
                len(response_body),
            )
            return (
                response.status,
                response.headers.get(
                    "Content-Type",
                    "application/octet-stream",
                ),
                response_body,
            )
        finally:
            response.close()

    def enter_request(
        self,
        *,
        final_flush: bool = False,
    ) -> tuple[bool, str]:
        with self._finalization_condition:
            state = self._finalization_state
            if state in {"draining", "closed"}:
                return False, state
            if state == "flushing" and not final_flush:
                return False, state
            self._active_requests += 1
            return True, state

    def leave_request(self) -> None:
        with self._finalization_condition:
            if self._active_requests <= 0:
                raise RuntimeError("finalization gate request count underflow")
            self._active_requests -= 1
            if self._active_requests == 0:
                self._finalization_condition.notify_all()

    def begin_finalization(
        self,
        timeout_seconds: float = FINALIZATION_DRAIN_TIMEOUT_SECONDS,
    ) -> bool:
        deadline = time.monotonic() + timeout_seconds
        with self._finalization_condition:
            self._finalization_state = "draining"
            while self._active_requests:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._finalization_condition.wait(timeout=remaining)
            self._finalization_state = "flushing"
            return True

    def end_finalization(self) -> None:
        with self._finalization_condition:
            self._finalization_state = "closed"
            self._finalization_condition.notify_all()

    def activate_trial(self) -> bool:
        with self._finalization_condition:
            if (
                self._finalization_state != "closed"
                or self._active_requests
            ):
                return False
            self._finalization_state = "open"
            return True

    @property
    def finalization_state(self) -> str:
        with self._finalization_condition:
            return self._finalization_state


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
            RUNNER_OPEN_TRIAL_PATH,
        }
    )

    def log_message(self, format_string: str, *arguments: object) -> None:
        LOGGER.debug(format_string, *arguments)

    def __getattr__(self, name: str) -> object:
        if name.startswith("do_"):
            return self._handle
        raise AttributeError(name)

    def _send_json(self, status: int, body: object) -> None:
        serialized = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self._send_body(status, serialized, "application/json")

    def _send_body(
        self,
        status: int,
        body: bytes,
        content_type: str,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

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
        if path == RUNNER_OPEN_TRIAL_PATH and self.command == "POST":
            self._read_body()
            if not self.server.state.valid_runner_control_token(
                self.headers.get(RUNNER_CONTROL_HEADER)
            ):
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "NotFound"})
                return True
            if not self.server.state.activate_trial():
                self._send_json(
                    HTTPStatus.CONFLICT,
                    {"error": "EvalTrialGateStateInvalid"},
                )
                return True
            self._send_json(HTTPStatus.OK, {"trial_open": True})
            return True
        if path == "/internal/finalization/begin" and self.command == "POST":
            self._read_body()
            if not self.server.state.valid_flush_token(
                self.headers.get("X-Agent-Workspace-Flush")
            ):
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "NotFound"})
                return True
            if not self.server.state.begin_finalization():
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "PrivilegedRequestDrainTimedOut"},
                )
                return True
            self._send_json(HTTPStatus.OK, {"finalizing": True})
            return True
        if path == "/internal/finalization/end" and self.command == "POST":
            self._read_body()
            if not self.server.state.valid_flush_token(
                self.headers.get("X-Agent-Workspace-Flush")
            ):
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "NotFound"})
                return True
            self.server.state.end_finalization()
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
                or status < 200
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

    def _handle_model_proxy(self) -> None:
        try:
            body, _ = self._read_body()
            status, content_type, response_body = (
                self.server.state.forward_model_request(
                    body,
                    content_type=self.headers.get(
                        "Content-Type",
                        "application/json",
                    ),
                    accept=self.headers.get("Accept", "application/json"),
                )
            )
            self._send_body(status, response_body, content_type)
        except BrokerStubConfigurationError as error:
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "error": "EvalModelProxyUnavailable",
                    "message": str(error),
                },
            )
        except (OSError, urllib_error.URLError) as error:
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "error": "EvalModelProxyUnavailable",
                    "message": str(error),
                },
            )

    def _handle_candidate_mantle(self, path: str) -> None:
        try:
            body: bytes | None = None
            if self.command != "GET":
                body, _ = self._read_body()
            status, content_type, response_body = (
                self.server.state.forward_candidate_mantle_request(
                    self.command,
                    path,
                    body,
                    {
                        key: value
                        for key, value in self.headers.items()
                    },
                )
            )
            self._send_body(status, response_body, content_type)
        except CandidateMantleAuthorityUnavailable:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "Invocation authority is unavailable"},
            )
        except BrokerStubConfigurationError as error:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {
                    "error": "EvalUnsupportedCandidateModelOperation",
                    "message": str(error),
                },
            )
        except (OSError, urllib_error.URLError) as error:
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "error": "EvalCandidateModelRelayUnavailable",
                    "message": str(error),
                },
            )

    def _capture_finalization_rejection(self, route: str) -> None:
        try:
            trial = self.server.state.load_trial()
            self.server.state.capture(
                {
                    "trial_id": trial.get("trial_id"),
                    "task_id": trial.get("task_id"),
                    "route": route,
                    "method": self.command,
                    "headers": {
                        key.lower(): value
                        for key, value in self.headers.items()
                    },
                    "body": None,
                    "stub_error": (
                        f"{FINALIZING_ERROR}: rejected {self.command} {route}"
                    ),
                }
            )
        except (BrokerStubConfigurationError, OSError):
            pass

    def _handle(self) -> None:
        path = urlsplit(self.path).path
        if self._handle_control(path):
            return
        if path.startswith(f"/{CANDIDATE_MANTLE_PREFIX}/"):
            entered, _ = self.server.state.enter_request()
            if not entered:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": FINALIZING_ERROR},
                )
                return
            try:
                self._handle_candidate_mantle(path)
            finally:
                self.server.state.leave_request()
            return
        if path.startswith("/agent-broker/"):
            route = path[len("/agent-broker") :]
            final_flush = (
                route == "/api/agent/workspace-storage"
                and self.server.state.valid_flush_token(
                    self.headers.get("X-Agent-Workspace-Flush")
                )
            )
            entered, rejected_state = self.server.state.enter_request(
                final_flush=final_flush
            )
            if not entered:
                if rejected_state != "closed":
                    self._capture_finalization_rejection(route)
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": FINALIZING_ERROR},
                )
                return
            try:
                self._handle_agent_broker(path)
            finally:
                self.server.state.leave_request()
            return
        if path == MODEL_MESSAGES_PATH:
            if self.command != "POST":
                self._send_json(
                    HTTPStatus.METHOD_NOT_ALLOWED,
                    {"error": "EvalModelMethodNotAllowed"},
                )
                return
            entered, _ = self.server.state.enter_request()
            if not entered:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": FINALIZING_ERROR},
                )
                return
            try:
                self._handle_model_proxy()
            finally:
                self.server.state.leave_request()
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
    workspace_flush_token_path: Path | None = None,
    invocation_context_path: Path | None = None,
    request_proof_key_path: Path | None = None,
    model_upstream_base_url: str | None = None,
) -> BrokerStubServer:
    control_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(control_directory, 0o700)
    return BrokerStubServer(
        (host, port),
        BrokerStubState(
            control_directory,
            workspace_flush_token_path=workspace_flush_token_path,
            invocation_context_path=invocation_context_path,
            request_proof_key_path=request_proof_key_path,
            model_upstream_base_url=model_upstream_base_url,
        ),
    )


def main(arguments: list[str] | None = None) -> None:
    requested = list(sys.argv[1:] if arguments is None else arguments)
    control_directory = Path(
        os.environ.get(CONTROL_DIRECTORY_ENV, DEFAULT_CONTROL_DIRECTORY)
    )
    if requested == [RUNNER_WRITE_TRIAL_COMMAND]:
        install_and_activate_trial(
            control_directory,
            sys.stdin.buffer.read(),
        )
        return
    if requested == [RUNNER_READ_CAPTURES_COMMAND]:
        sys.stdout.buffer.write(collect_trial_captures(control_directory))
        return
    if requested:
        raise SystemExit("unsupported eval broker stub command")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
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
